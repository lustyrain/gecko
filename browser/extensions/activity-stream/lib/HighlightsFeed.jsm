/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

ChromeUtils.import("resource://gre/modules/Services.jsm");

const {actionTypes: at} = ChromeUtils.import("resource://activity-stream/common/Actions.jsm", {});

const {shortURL} = ChromeUtils.import("resource://activity-stream/lib/ShortURL.jsm", {});
const {SectionsManager} = ChromeUtils.import("resource://activity-stream/lib/SectionsManager.jsm", {});
const {TOP_SITES_DEFAULT_ROWS, TOP_SITES_MAX_SITES_PER_ROW} = ChromeUtils.import("resource://activity-stream/common/Reducers.jsm", {});
const {Dedupe} = ChromeUtils.import("resource://activity-stream/common/Dedupe.jsm", {});

ChromeUtils.defineModuleGetter(this, "filterAdult",
  "resource://activity-stream/lib/FilterAdult.jsm");
ChromeUtils.defineModuleGetter(this, "LinksCache",
  "resource://activity-stream/lib/LinksCache.jsm");
ChromeUtils.defineModuleGetter(this, "NewTabUtils",
  "resource://gre/modules/NewTabUtils.jsm");
ChromeUtils.defineModuleGetter(this, "Screenshots",
  "resource://activity-stream/lib/Screenshots.jsm");
ChromeUtils.defineModuleGetter(this, "PageThumbs",
  "resource://gre/modules/PageThumbs.jsm");

const HIGHLIGHTS_MAX_LENGTH = 9;
const MANY_EXTRA_LENGTH = HIGHLIGHTS_MAX_LENGTH * 5 + TOP_SITES_DEFAULT_ROWS * TOP_SITES_MAX_SITES_PER_ROW;
const SECTION_ID = "highlights";
const SYNC_BOOKMARKS_FINISHED_EVENT = "weave:engine:sync:applied";
const BOOKMARKS_RESTORE_SUCCESS_EVENT = "bookmarks-restore-success";
const BOOKMARKS_RESTORE_FAILED_EVENT = "bookmarks-restore-failed";

this.HighlightsFeed = class HighlightsFeed {
  constructor() {
    this.dedupe = new Dedupe(this._dedupeKey);
    this.linksCache = new LinksCache(NewTabUtils.activityStreamLinks,
      "getHighlights", ["image"]);
    PageThumbs.addExpirationFilter(this);
  }

  _dedupeKey(site) {
    // Treat bookmarks and pocket items as un-dedupable, otherwise show one of a url
    return site && ((site.pocket_id || site.type === "bookmark") ? {} : site.url);
  }

  init() {
    Services.obs.addObserver(this, SYNC_BOOKMARKS_FINISHED_EVENT);
    Services.obs.addObserver(this, BOOKMARKS_RESTORE_SUCCESS_EVENT);
    Services.obs.addObserver(this, BOOKMARKS_RESTORE_FAILED_EVENT);
    SectionsManager.onceInitialized(this.postInit.bind(this));
  }

  postInit() {
    SectionsManager.enableSection(SECTION_ID);
    this.fetchHighlights({broadcast: true});
  }

  uninit() {
    SectionsManager.disableSection(SECTION_ID);
    PageThumbs.removeExpirationFilter(this);
    Services.obs.removeObserver(this, SYNC_BOOKMARKS_FINISHED_EVENT);
    Services.obs.removeObserver(this, BOOKMARKS_RESTORE_SUCCESS_EVENT);
    Services.obs.removeObserver(this, BOOKMARKS_RESTORE_FAILED_EVENT);
  }

  observe(subject, topic, data) {
    // When we receive a notification that a sync has happened for bookmarks,
    // or Places finished importing or restoring bookmarks, refresh highlights
    const manyBookmarksChanged =
      (topic === SYNC_BOOKMARKS_FINISHED_EVENT && data === "bookmarks") ||
      topic === BOOKMARKS_RESTORE_SUCCESS_EVENT ||
      topic === BOOKMARKS_RESTORE_FAILED_EVENT;
    if (manyBookmarksChanged) {
      this.fetchHighlights({broadcast: true});
    }
  }

  filterForThumbnailExpiration(callback) {
    const state = this.store.getState().Sections.find(section => section.id === SECTION_ID);

    callback(state && state.initialized ? state.rows.reduce((acc, site) => {
      // Screenshots call in `fetchImage` will search for preview_image_url or
      // fallback to URL, so we prevent both from being expired.
      acc.push(site.url);
      if (site.preview_image_url) {
        acc.push(site.preview_image_url);
      }
      return acc;
    }, []) : []);
  }

  /**
   * Refresh the highlights data for content.
   * @param {bool} options.broadcast Should the update be broadcasted.
   */
  async fetchHighlights(options = {}) {
    // We need TopSites for deduping, so wait for TOP_SITES_UPDATED.
    if (!this.store.getState().TopSites.initialized) {
      return;
    }

    // We broadcast when we want to force an update, so get fresh links
    if (options.broadcast) {
      this.linksCache.expire();
    }

    // Request more than the expected length to allow for items being removed by
    // deduping against Top Sites or multiple history from the same domain, etc.
    const manyPages = await this.linksCache.request({
      numItems: MANY_EXTRA_LENGTH,
      excludePocket: !this.store.getState().Prefs.values["section.highlights.includePocket"]
    });

    // Remove adult highlights if we need to
    const checkedAdult = this.store.getState().Prefs.values.filterAdult ?
      filterAdult(manyPages) : manyPages;

    // Remove any Highlights that are in Top Sites already
    const [, deduped] = this.dedupe.group(this.store.getState().TopSites.rows, checkedAdult);

    // Keep all "bookmark"s and at most one (most recent) "history" per host
    const highlights = [];
    const hosts = new Set();
    for (const page of deduped) {
      const hostname = shortURL(page);
      // Skip this history page if we already something from the same host
      if (page.type === "history" && hosts.has(hostname)) {
        continue;
      }

      // If we already have the image for the card, use that immediately. Else
      // asynchronously fetch the image.
      if (!page.image) {
        this.fetchImage(page);
      }

      // Adjust the type for 'history' items that are also 'bookmarked'
      if (page.type === "history" && page.bookmarkGuid) {
        page.type = "bookmark";
      }

      // We want the page, so update various fields for UI
      Object.assign(page, {
        hasImage: true, // We always have an image - fall back to a screenshot
        hostname,
        type: page.type,
        pocket_id: page.pocket_id
      });

      // Add the "bookmark", "pocket", or not-skipped "history"
      highlights.push(page);
      hosts.add(hostname);

      // Remove internal properties that might be updated after dispatch
      delete page.__sharedCache;

      // Skip the rest if we have enough items
      if (highlights.length === HIGHLIGHTS_MAX_LENGTH) {
        break;
      }
    }

    const {initialized} = this.store.getState().Sections.find(section => section.id === SECTION_ID);
    // Broadcast when required or if it is the first update.
    const shouldBroadcast = options.broadcast || !initialized;

    SectionsManager.updateSection(SECTION_ID, {rows: highlights}, shouldBroadcast);
  }

  /**
   * Fetch an image for a given highlight and update the card with it. If no
   * image is available then fallback to fetching a screenshot.
   */
  fetchImage(page) {
    // Request a screenshot if we don't already have one pending
    const {preview_image_url: imageUrl, url} = page;
    Screenshots.maybeCacheScreenshot(page, imageUrl || url, "image", image => {
      SectionsManager.updateSectionCard(SECTION_ID, url, {image}, true);
    });
  }

  /**
   * Deletes an item from a user's saved to Pocket feed and then refreshes highlights
   * @param {int} itemID
   *  The unique ID given by Pocket for that item; used to look the item up when deleting
   */
  async deleteFromPocket(itemID) {
    try {
      await NewTabUtils.activityStreamLinks.deletePocketEntry(itemID);
      this.fetchHighlights({broadcast: true});
    } catch (err) {
      Cu.reportError(err);
    }
  }

  /**
   * Archives an item from a user's saved to Pocket feed and then refreshes highlights
   * @param {int} itemID
   *  The unique ID given by Pocket for that item; used to look the item up when archiving
   */
  async archiveFromPocket(itemID) {
    try {
      await NewTabUtils.activityStreamLinks.archivePocketEntry(itemID);
      this.fetchHighlights({broadcast: true});
    } catch (err) {
      Cu.reportError(err);
    }
  }

  onAction(action) {
    switch (action.type) {
      case at.INIT:
        this.init();
        break;
      case at.SYSTEM_TICK:
      case at.TOP_SITES_UPDATED:
        this.fetchHighlights({broadcast: false});
        break;
      case at.MIGRATION_COMPLETED:
      case at.PLACES_HISTORY_CLEARED:
      case at.PLACES_LINK_BLOCKED:
        this.fetchHighlights({broadcast: true});
        break;
      case at.DELETE_FROM_POCKET:
        this.deleteFromPocket(action.data.pocket_id);
        break;
      case at.ARCHIVE_FROM_POCKET:
        this.archiveFromPocket(action.data.pocket_id);
        break;
      case at.PLACES_LINKS_CHANGED:
      case at.PLACES_SAVED_TO_POCKET:
        this.linksCache.expire();
        this.fetchHighlights({broadcast: false});
        break;
      case at.UNINIT:
        this.uninit();
        break;
    }
  }
};

const EXPORTED_SYMBOLS = ["HighlightsFeed", "SECTION_ID", "MANY_EXTRA_LENGTH", "SYNC_BOOKMARKS_FINISHED_EVENT", "BOOKMARKS_RESTORE_SUCCESS_EVENT", "BOOKMARKS_RESTORE_FAILED_EVENT"];
