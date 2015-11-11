 /**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */
'use strict';

const Fastfs = require('../fastfs');
const ModuleCache = require('../ModuleCache');
const Promise = require('promise');
const crawl = require('../crawlers');
const getPlatformExtension = require('../lib/getPlatformExtension');
const isAbsolutePath = require('absolute-path');
const path = require('path');
const util = require('util');
const Helpers = require('./Helpers');
const ResolutionRequest = require('./ResolutionRequest');
const ResolutionResponse = require('./ResolutionResponse');
const HasteMap = require('./HasteMap');
const DeprecatedAssetMap = require('./DeprecatedAssetMap');

const defaultActivity = {
  startEvent: () => {},
  endEvent: () => {},
};

class DependencyGraph {
  constructor({
    activity,
    roots,
    ignoreFilePath,
    fileWatcher,
    assetRoots_DEPRECATED,
    assetExts,
    providesModuleNodeModules,
    platforms,
    cache,
    mocksPattern,
  }) {
    this._opts = {
      activity: activity || defaultActivity,
      roots,
      ignoreFilePath: ignoreFilePath || (() => {}),
      fileWatcher,
      assetRoots_DEPRECATED: assetRoots_DEPRECATED || [],
      assetExts: assetExts || [],
      providesModuleNodeModules,
      platforms: platforms || [],
      cache,
      mocksPattern,
    };
    this._cache = this._opts.cache;
    this._helpers = new Helpers(this._opts);
    this._mocks = null;
    this.load().catch((err) => {
      // This only happens at initialization. Live errors are easier to recover from.
      console.error('Error building DepdendencyGraph:\n', err.stack);
      process.exit(1);
    });
  }

  load() {
    if (this._loading) {
      return this._loading;
    }

    const {activity} = this._opts;
    const depGraphActivity = activity.startEvent('Building Dependency Graph');
    const crawlActivity = activity.startEvent('Crawling File System');
    const allRoots = this._opts.roots.concat(this._opts.assetRoots_DEPRECATED);
    this._crawling = crawl(allRoots, {
      ignore: this._opts.ignoreFilePath,
      exts: ['js', 'json'].concat(this._opts.assetExts),
      fileWatcher: this._opts.fileWatcher,
    });
    this._crawling.then((files) => activity.endEvent(crawlActivity));

    this._fastfs = new Fastfs(
      'JavaScript',
      this._opts.roots,
      this._opts.fileWatcher,
      {
        ignore: this._opts.ignoreFilePath,
        crawling: this._crawling,
        activity: activity,
      }
    );

    this._fastfs.on('change', this._processFileChange.bind(this));

    this._moduleCache = new ModuleCache(this._fastfs, this._cache);

    this._hasteMap = new HasteMap({
      fastfs: this._fastfs,
      moduleCache: this._moduleCache,
      assetExts: this._opts.exts,
      helpers: this._helpers,
    });

    this._deprecatedAssetMap = new DeprecatedAssetMap({
      fsCrawl: this._crawling,
      roots: this._opts.assetRoots_DEPRECATED,
      helpers: this._helpers,
      fileWatcher: this._opts.fileWatcher,
      ignoreFilePath: this._opts.ignoreFilePath,
      assetExts: this._opts.assetExts,
      activity: this._opts.activity,
    });

    this._loading = Promise.all([
      this._fastfs.build()
        .then(() => {
          this._findAllMocks();
          const hasteActivity = activity.startEvent('Building Haste Map');
          return this._hasteMap.build().then(() => activity.endEvent(hasteActivity));
        }),
      this._deprecatedAssetMap.build(),
    ]).then(() =>
      activity.endEvent(depGraphActivity)
    );

    return this._loading;
  }

  getDependencies(entryPath, platform) {
    return this.load().then(() => {
      platform = this._getRequestPlatform(entryPath, platform);
      const absPath = this._getAbsolutePath(entryPath);
      const req = new ResolutionRequest({
        platform,
        entryPath: absPath,
        deprecatedAssetMap: this._deprecatedAssetMap,
        hasteMap: this._hasteMap,
        helpers: this._helpers,
        moduleCache: this._moduleCache,
        fastfs: this._fastfs,
        mocks: this._mocks,
      });

      const response = new ResolutionResponse();

      return Promise.all([
        req.getOrderedDependencies(response),
        req.getAsyncDependencies(response),
      ]).then(() => response);
    });
  }

  // Returns a list of all the mocks if the `mocksPattern` option was specified.
  // Mocks can be created for dynamic or generated modules which are not part
  // of the dependency graph. This function gives access to all available
  // mocks in all the roots.
  getAllMocks() {
    return this.load().then(() => this._mocks);
  }

  _getRequestPlatform(entryPath, platform) {
    if (platform == null) {
      platform = getPlatformExtension(entryPath);
      if (platform == null || this._opts.platforms.indexOf(platform) === -1) {
        platform = null;
      }
    } else if (this._opts.platforms.indexOf(platform) === -1) {
      throw new Error('Unrecognized platform: ' + platform);
    }
    return platform;
  }

  _getAbsolutePath(filePath) {
    if (isAbsolutePath(filePath)) {
      return path.resolve(filePath);
    }

    for (let i = 0; i < this._opts.roots.length; i++) {
      const root = this._opts.roots[i];
      const potentialAbsPath = path.join(root, filePath);
      if (this._fastfs.fileExists(potentialAbsPath)) {
        return path.resolve(potentialAbsPath);
      }
    }

    throw new NotFoundError(
      'Cannot find entry file %s in any of the roots: %j',
      filePath,
      this._opts.roots
    );
  }

  _processFileChange(type, filePath, root, fstat) {
    const absPath = path.join(root, filePath);
    if (fstat && fstat.isDirectory() ||
        this._opts.ignoreFilePath(absPath) ||
        this._helpers.isNodeModulesDir(absPath)) {
      return;
    }

    // Ok, this is some tricky promise code. Our requirements are:
    // * we need to report back failures
    // * failures shouldn't block recovery
    // * Errors can leave `hasteMap` in an incorrect state, and we need to rebuild
    // After we process a file change we record any errors which will also be
    // reported via the next request. On the next file change, we'll see that
    // we are in an error state and we should decide to do a full rebuild.
    this._loading = this._loading.finally(() => {
      if (this._hasteMapError) {
        console.warn(
          'Rebuilding haste map to recover from error:\n' +
          this._hasteMapError.stack
        );
        this._hasteMapError = null;

        // Rebuild the entire map if last change resulted in an error.
        this._loading = this._hasteMap.build();
      } else {
        this._loading = this._hasteMap.processFileChange(type, absPath);
        this._loading.catch((e) => this._hasteMapError = e);
      }
      return this._loading;
    });
  }

  _findAllMocks() {
    const mocksPattern = this._opts.mocksPattern;

    // Take all mocks in all the roots into account. This is necessary
    // because currently mocks are global: any module can be mocked by
    // any mock in the system.
    if (mocksPattern) {
      this._mocks = Object.create(null);
      this._fastfs.matchFilesByPattern(mocksPattern).forEach(file => {
        const id = path.basename(file, path.extname(file));
        this._mocks[id] = file;
      });
    }
  }
}

function NotFoundError() {
  Error.call(this);
  Error.captureStackTrace(this, this.constructor);
  var msg = util.format.apply(util, arguments);
  this.message = msg;
  this.type = this.name = 'NotFoundError';
  this.status = 404;
}
util.inherits(NotFoundError, Error);

module.exports = DependencyGraph;
