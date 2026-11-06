'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function loadJSDOM() {
  try {
    return require('jsdom').JSDOM;
  } catch {
    const runtime = process.env.WINVPLUS_TEST_RUNTIME;
    if (!runtime) {
      throw new Error(
        'jsdom is required. Run "npm install --no-audit --no-fund" in this tests directory, or set WINVPLUS_TEST_RUNTIME to its install prefix.',
      );
    }

    const searchPaths = [runtime];
    if (path.basename(runtime).toLowerCase() === 'node_modules') {
      searchPaths.push(path.dirname(runtime));
    }
    try {
      return require(require.resolve('jsdom', { paths: searchPaths })).JSDOM;
    } catch (error) {
      throw new Error(
        `Cannot load jsdom from WINVPLUS_TEST_RUNTIME=${runtime}. Run npm install in this tests directory.`,
        { cause: error },
      );
    }
  }
}

const JSDOM = loadJSDOM();
const source = fs.readFileSync(path.resolve(__dirname, '../ui/phrases.js'), 'utf8');
const fixtureHtml = `<!doctype html>
<html><head></head><body>
  <nav id="navigation-menu-container" class="navigation-menu-container">
    <ul class="navigation-menu">
      <li role="none"><div id="navigation-menu-item-container-home" class="navigation-menu-item"><span>Home</span></div></li>
      <li role="none"><div id="navigation-menu-item-container-clipboard-history" class="navigation-menu-item"><span>Clipboard history</span></div></li>
      <li role="none"><div id="navigation-menu-item-container-settings" class="navigation-menu-item"><span>Settings</span></div></li>
    </ul>
  </nav>
  <div id="expanded-view-content">
    <ul id="expanded-view-content-lists"></ul>
    <div id="expanded-view-scroll-space"></div>
  </div>
</body></html>`;

function makeObservable(initialValue) {
  let value = initialValue;
  const subscribers = new Set();
  const observable = function (nextValue) {
    if (arguments.length) {
      value = nextValue;
      for (const callback of [...subscribers]) callback(value);
    }
    return value;
  };
  observable.__isObservable = true;
  observable.subscribe = (callback) => {
    subscribers.add(callback);
    return { dispose: () => subscribers.delete(callback) };
  };
  return observable;
}

function makeObservableArray(initialValue) {
  const observable = makeObservable(initialValue.slice());
  observable.remove = (itemOrPredicate) => {
    const current = observable();
    const matches = typeof itemOrPredicate === 'function'
      ? itemOrPredicate
      : (item) => item === itemOrPredicate;
    const removed = current.filter(matches);
    if (removed.length) observable(current.filter((item) => !matches(item)));
    return removed;
  };
  observable.indexOf = (item) => observable().indexOf(item);
  observable.push = (...items) => {
    const current = observable();
    const length = current.push(...items);
    observable(current);
    return length;
  };
  observable.splice = (...args) => {
    const current = observable();
    const removed = current.splice(...args);
    observable(current);
    return removed;
  };
  return observable;
}

function instrumentListeners(target, trackedTypes) {
  const active = new Map(trackedTypes.map((type) => [type, new Set()]));
  const nativeAdd = target.addEventListener.bind(target);
  const nativeRemove = target.removeEventListener.bind(target);
  target.addEventListener = function (type, listener, options) {
    if (active.has(type)) active.get(type).add(listener);
    return nativeAdd(type, listener, options);
  };
  target.removeEventListener = function (type, listener, options) {
    if (active.has(type)) active.get(type).delete(listener);
    return nativeRemove(type, listener, options);
  };
  return {
    count(type) { return active.get(type).size; },
    total() { return [...active.values()].reduce((sum, set) => sum + set.size, 0); },
  };
}

function instrumentElementListeners(target, trackedType) {
  const active = new Set();
  const nativeAdd = target.addEventListener.bind(target);
  const nativeRemove = target.removeEventListener.bind(target);
  target.addEventListener = function (type, listener, options) {
    if (type === trackedType) active.add(listener);
    return nativeAdd(type, listener, options);
  };
  target.removeEventListener = function (type, listener, options) {
    if (type === trackedType) active.delete(listener);
    return nativeRemove(type, listener, options);
  };
  return { count() { return active.size; } };
}

function createFixture(rootSetup) {
  const dom = new JSDOM(fixtureHtml, {
    url: 'https://winvplus.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;
  const dataByElement = new WeakMap();
  const visibilityUpdates = [];
  const activeTimeouts = new Set();
  let pasteCalls = 0;

  class NativeNavigationItem {
    constructor(options = {}) {
      this.id = options.id;
      this.displayLabel = options.displayLabel || '';
      this.accessibilityLabel = options.accessibilityLabel || options.id;
      this.displayLabelFontOverride = options.displayLabelFontOverride || '';
      this.containerHtmlId = `navigation-menu-item-container-${this.id}`;
      this.htmlId = `navigation-menu-item-${this.id}`;
      this.isSelected = makeObservable(false);
      this.isHidden = makeObservable(false);
      this.isDisabled = makeObservable(false);
      this.hasFocus = makeObservable(false);
    }
    getAriaLabel() { return this.accessibilityLabel; }
  }

  class NativeAction {
    constructor(options = {}, asyncHandler = () => Promise.resolve()) {
      Object.assign(this, options);
      this.asyncHandler = asyncHandler;
    }
  }

  const ko = {
    observable: makeObservable,
    observableArray: makeObservableArray,
    pureComputed(read) {
      const computed = () => read();
      computed.__isObservable = true;
      computed.dispose = () => {};
      return computed;
    },
    isObservable(value) { return !!(value && value.__isObservable); },
    unwrap(value) { return this.isObservable(value) ? value() : value; },
    dataFor(element) { return dataByElement.get(element); },
  };
  window.ko = ko;

  const nav = document.getElementById('navigation-menu-container');
  const navList = nav.querySelector('.navigation-menu');
  const home = new NativeNavigationItem({ id: 'home', displayLabel: 'Home' });
  const clipboard = new NativeNavigationItem({
    id: 'clipboard-history', displayLabel: 'Clipboard history',
    accessibilityLabel: 'Clipboard history',
  });
  const settings = new NativeNavigationItem({ id: 'settings', displayLabel: 'Settings' });
  clipboard.isSelected(true);

  const root = {
    currentViewId: ko.observable('clipboard-history'),
    isLastShowHideEventShow: ko.observable(true),
    delegationModel: {
      doCtrlVKeyInjectAsync() {
        pasteCalls++;
        return Promise.resolve();
      },
    },
    customNavigationMenuClickHandlers: [],
    appendCustomClickHandlerToNavigationMenuModel(handler) {
      this.customNavigationMenuClickHandlers.push(handler);
    },
  };
  const navModel = {
    customNavigationMenuClickHandlers: root.customNavigationMenuClickHandlers,
    navigationMenuItems: ko.observableArray([home, clipboard, settings]),
    updateNavigationMenuItemsVisibility(items, currentViewId) {
      visibilityUpdates.push({ ids: items.map((item) => item.id), currentViewId });
      items.forEach((item) => item.isHidden(false));
    },
  };
  root.navigationMenuViewModel = navModel;

  function renderNavigationItems(items) {
    navList.replaceChildren();
    items.filter((item) => !ko.unwrap(item.isHidden)).forEach((item) => {
      const row = document.createElement('li');
      row.setAttribute('role', 'none');
      const tab = document.createElement('div');
      tab.id = item.containerHtmlId;
      tab.className = 'navigation-menu-item';
      tab.setAttribute('role', 'listitem');
      tab.setAttribute('aria-label', item.getAriaLabel());
      tab.setAttribute('aria-selected', String(ko.unwrap(item.isSelected)));
      tab.tabIndex = ko.unwrap(item.isDisabled) ? -1 : 0;
      const label = document.createElement('span');
      label.id = item.htmlId;
      label.textContent = item.displayLabel;
      tab.appendChild(label);
      row.appendChild(tab);
      navList.appendChild(row);
      dataByElement.set(tab, item);
      tab.addEventListener('click', () => {
        for (const handler of navModel.customNavigationMenuClickHandlers) {
          if (handler.onNavigationMenuItemClick(item)) return;
        }
        navModel.navigationMenuItems().forEach((candidate) => candidate.isSelected(candidate === item));
        root.currentViewId(item.id);
      });
    });
  }
  navModel.navigationMenuItems.subscribe(renderNavigationItems);
  renderNavigationItems(navModel.navigationMenuItems());
  dataByElement.set(nav, root);
  dataByElement.set(document.getElementById(clipboard.containerHtmlId), clipboard);

  if (rootSetup) rootSetup({ root, ko, window, document, nav, dataByElement });

  const documentListeners = instrumentListeners(document, ['contextmenu', 'pointerdown', 'keydown']);
  const navigationListeners = instrumentListeners(nav, ['click']);
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const setTrackedTimeout = (callback, delay, ...args) => {
    let handle;
    handle = nativeSetTimeout(() => {
      activeTimeouts.delete(handle);
      callback(...args);
    }, delay);
    activeTimeouts.add(handle);
    return handle;
  };
  const clearTrackedTimeout = (handle) => {
    activeTimeouts.delete(handle);
    nativeClearTimeout(handle);
  };
  const inject = () => vm.runInNewContext(source, {
    window,
    document,
    ko,
    Date: window.Date,
    setTimeout: setTrackedTimeout,
    clearTimeout: clearTrackedTimeout,
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
  }, { filename: 'phrases.js' });
  inject();

  function addHistoryItem(id, type, value) {
    const item = {
      id,
      type,
      text: type === 'text' ? value : undefined,
      preview: type === 'image' ? value : undefined,
      moreCalls: 0,
      hideSecondaryCalls: [],
      hideSecondaryViewAsync(options) {
        this.hideSecondaryCalls.push(options);
        return Promise.resolve();
      },
    };
    item.primaryMore = new NativeAction(
      { id: 'primary-more', position: 10, label: '更多' },
      () => { item.moreCalls++; return Promise.resolve(); },
    );
    item.secondaryDelete = new NativeAction(
      { id: 'secondary-delete', position: 20, label: '删除' },
    );
    item.actions = makeObservableArray([item.primaryMore, item.secondaryDelete]);

    const card = document.createElement('li');
    card.className = 'expanded-view-list-item clipboard-history-items-list-item';
    card.setAttribute('role', 'row');
    const content = document.createElement('div');
    content.className = 'clipboard-history-items-list-item-content';
    content.setAttribute('role', 'cell');

    let label;
    let image;
    if (type === 'text') {
      label = document.createElement('span');
      label.className = 'clipboard-history-items-list-item-text';
      label.textContent = value;
      content.appendChild(label);
    } else {
      card.classList.add('expanded-view-list-item-media');
      const frame = document.createElement('div');
      frame.className = 'clipboard-history-items-list-item-imageframe';
      image = document.createElement('img');
      image.className = 'clipboard-history-items-list-item-image';
      image.src = value;
      frame.appendChild(image);
      content.appendChild(frame);
    }

    const primaryActions = document.createElement('ul');
    primaryActions.className = 'clipboard-history-items-list-item-actions-primary-view';
    const more = document.createElement('li');
    more.className = 'clipboard-history-items-list-item-action primary-more';
    more.setAttribute('data-native-action-id', item.primaryMore.id);
    more.addEventListener('click', () => item.primaryMore.asyncHandler());
    primaryActions.appendChild(more);

    const secondaryActions = document.createElement('ul');
    secondaryActions.className = 'clipboard-history-items-list-item-actions-secondary-view';
    const secondaryDelete = document.createElement('li');
    secondaryDelete.className = 'clipboard-history-items-list-item-action secondary-delete';
    secondaryDelete.setAttribute('data-native-action-id', item.secondaryDelete.id);
    secondaryActions.appendChild(secondaryDelete);

    card.appendChild(content);
    card.appendChild(primaryActions);
    card.appendChild(secondaryActions);
    document.getElementById('expanded-view-content-lists').appendChild(card);
    dataByElement.set(card, item);
    return { card, label, image, item, more, secondaryDelete };
  }

  function addTextHistoryItem(id, text) {
    return addHistoryItem(id, 'text', text);
  }

  function addImageHistoryItem(id) {
    return addHistoryItem(id, 'image', `data:image/png;base64,${id}`);
  }

  return {
    dom, window, document, root, navModel, nav, clipboard,
    visibilityUpdates, documentListeners, navigationListeners,
    inject, addTextHistoryItem, addImageHistoryItem,
    get pendingTimeoutCount() { return activeTimeouts.size; },
    get pasteCalls() { return pasteCalls; },
    activate() {
      document.getElementById('navigation-menu-item-container-winvplus-phrases').click();
      assert.equal(window.__winvPlus.active, true);
    },
  };
}

function dispatchContextMenu(window, target, button = 2) {
  const event = new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button, clientX: 30, clientY: 40,
  });
  target.dispatchEvent(event);
  return event;
}

function drainRequests(window) {
  return JSON.parse(JSON.stringify(window.__winvPlus.drain().requests));
}

function createHistoryCacheHarness({ root, window, document }) {
  const nativeListeners = new Set();
  const calls = { initialize: 0, nativeChanges: 0, fetches: 0 };
  const nativeActivation = makeObservable(false);
  const pendingResults = [];
  let fetchHandler = () => Promise.resolve({ items: [{ id: 'history-item' }] });

  function initialize(activation) {
    calls.initialize++;
    const callback = () => this.handleClipboardHistoryChange();
    const update = (enabled) => {
      if (enabled) nativeListeners.add(callback);
      else nativeListeners.delete(callback);
    };
    activation.subscribe(update);
    update(activation());
  }
  const source = {
    initialize,
    fetchAsync(...args) {
      calls.fetches++;
      const next = pendingResults.shift();
      return next ? next(...args) : fetchHandler(...args);
    },
    isDataRefreshNecessary() { return true; },
    handleClipboardHistoryChange() { calls.nativeChanges++; },
  };
  const originalFetch = source.fetchAsync;
  const originalRefresh = source.isDataRefreshNecessary;
  root.isLastShowHideEventShow.subscribe((visible) => nativeActivation(visible));
  nativeActivation(root.isLastShowHideEventShow());
  root.navigationDataModel = {
    tryGetDataSourceCategoryByView(viewId) {
      return viewId === 'clipboard' ? [7, undefined] : [undefined, undefined];
    },
  };
  root.dataSourceCollection = {
    getDataSource(type) {
      assert.equal(type, 7);
      if (!source.__nativeInitialized) {
        source.__nativeInitialized = true;
        source.initialize(nativeActivation);
      }
      return source;
    },
  };

  async function openHistory() {
    if (!source.isDataRefreshNecessary()) return false;
    const list = document.getElementById('expanded-view-content-lists');
    list.replaceChildren();
    const result = await source.fetchAsync();
    for (const item of result.items || []) {
      const node = document.createElement('li');
      node.dataset.historyItemId = item.id;
      list.appendChild(node);
    }
    return true;
  }

  return {
    source,
    originalFetch,
    originalRefresh,
    calls,
    nativeListeners,
    pendingResults,
    setFetchHandler(handler) { fetchHandler = handler; },
    async fireHistoryChanged() {
      for (const listener of [...nativeListeners]) listener();
      await Promise.resolve();
    },
    openHistory,
  };
}

function createHistoryPagerHarness(context, recordCount = 300) {
  const harness = createHistoryCacheHarness(context);
  const { root, ko, document } = context;
  const calls = harness.calls;
  calls.cleanup = [];
  calls.clearAll = 0;
  harness.calls = calls;
  const models = Array.from({ length: recordCount }, (_, index) => ({
    id: `native-${index + 1}`,
    isClearAllApplicable: () => index >= 10,
  }));
  let fetchHandler = () => Promise.resolve({ items: models.slice() });
  harness.source.fetchAsync = function (...args) {
    calls.fetches++;
    const next = harness.pendingResults.shift();
    return next ? next(...args) : fetchHandler(...args);
  };
  harness.originalFetch = harness.source.fetchAsync;
  harness.setFetchHandler = (handler) => { fetchHandler = handler; };
  harness.source.thumbnailUrlCache = {
    historyItemThumbnailUrlCache: new Map(),
    cleanupHistoryItemThumbnails(items) { calls.cleanup.push(items.map((item) => item.id)); },
  };
  const creator = {
    create(list) {
      return [{ isEnabled: () => ko.unwrap(list.items).some((item) => item.isClearAllApplicable()),
        asyncHandler() { calls.clearAll++; return Promise.resolve(); } }];
    },
  };
  const originalCreate = creator.create;
  const config = { datasource: 7, listActionsCreator: creator };
  const lists = ko.observableArray([]);
  root.expandedViewModel = {
    viewLists: lists,
    getListConfig(type) { return type === 7 ? config : undefined; },
  };
  root.navigationDataModel.tryGetDataSourceCategoryByView = (viewId) =>
    ['clipboard', 'clipboard-history'].includes(viewId) ? [7, undefined] : [undefined, undefined];
  const content = document.getElementById('expanded-view-content');
  Object.defineProperties(content, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, writable: true, value: 500 },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });

  function render(list) {
    const container = document.getElementById('expanded-view-content-lists');
    const nodes = new Map();
    const draw = (items) => {
      const wanted = new Set(items.map((item) => item.id));
      for (const [id, node] of nodes) if (!wanted.has(id)) { node.remove(); nodes.delete(id); }
      items.forEach((item) => {
        if (nodes.has(item.id)) return;
        const node = document.createElement('li');
        node.className = 'clipboard-history-items-list-item';
        node.dataset.historyItemId = item.id;
        nodes.set(item.id, node);
        container.appendChild(node);
      });
    };
    list.items.subscribe(draw);
    draw(list.items());
    return nodes;
  }
  async function openHistory() {
    if (!harness.source.isDataRefreshNecessary()) return false;
    document.getElementById('expanded-view-content-lists').replaceChildren();
    lists([]);
    const result = await harness.source.fetchAsync({ query: '', offset: 0, max: 10 });
    const list = { config, items: ko.observableArray(result.items), listActions: [] };
    list.listActions = creator.create(list);
    const nodes = render(list);
    list.__nodes = nodes;
    lists([list]);
    return true;
  }
  return { ...harness, calls, models, creator, originalCreate, config, lists, content, openHistory };
}

function waitForMutationObserver(window) {
  return new Promise((resolve) => window.queueMicrotask(resolve));
}

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

function addRemovalAnimationStyle(document, duration = '.333s') {
  const style = document.createElement('style');
  style.textContent = [
    `.clipboard-history-items-list-item-remove-item-target-item{animation-duration:${duration}}`,
    `.clipboard-history-items-list-item-remove-item-move-up-subsequent-item{animation-duration:${duration}}`,
  ].join('\n');
  document.head.appendChild(style);
  const window = document.defaultView;
  window.__testRemovalAnimationDuration = duration;
  if (!window.__testComputedStyleWrapped) {
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    window.getComputedStyle = (element) => {
      const computed = nativeGetComputedStyle(element);
      if (!element.classList || !(
        element.classList.contains('clipboard-history-items-list-item-remove-item-target-item')
        || element.classList.contains('clipboard-history-items-list-item-remove-item-move-up-subsequent-item')
      )) return computed;
      return new Proxy(computed, {
        get(target, key) {
          if (key === 'animationDuration') return window.__testRemovalAnimationDuration;
          return Reflect.get(target, key, target);
        },
      });
    };
    window.__testComputedStyleWrapped = true;
  }
  return style;
}

function dispatchAnimationEnd(window, target, animationName) {
  const event = new window.Event('animationend', { bubbles: true });
  Object.defineProperty(event, 'animationName', { value: animationName });
  target.dispatchEvent(event);
  return event;
}

test('extends native history actions and saves text and image items through their handlers', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const { window, document, navModel, root } = fixture;

  assert.equal(window.__winvPlus.ready, true);
  const ids = navModel.navigationMenuItems().map((item) => item.id);
  assert.deepEqual(ids, ['home', 'clipboard-history', 'winvplus-phrases', 'settings']);
  assert.deepEqual(fixture.visibilityUpdates.at(-1).ids, ids);
  assert.deepEqual(
    [...document.querySelectorAll('.navigation-menu-item')].map((tab) => tab.id),
    ids.map((id) => `navigation-menu-item-container-${id}`),
  );

  const originalState = window.__winvPlus;
  fixture.inject();
  assert.equal(window.__winvPlus, originalState);
  assert.equal(document.querySelectorAll('#navigation-menu-item-container-winvplus-phrases').length, 1);
  assert.equal(document.querySelectorAll('#winvplus-style').length, 1);
  assert.equal(root.customNavigationMenuClickHandlers.length, 1);

  drainRequests(window);
  const textItem = fixture.addTextHistoryItem('clipboard-text-42', 'hello');
  await waitForMutationObserver(window);
  assert.deepEqual(textItem.item.actions().map((action) => action.id), [
    'primary-more', 'secondary-delete', 'winvplus-save',
  ]);
  const textSave = textItem.item.actions().find((action) => action.id === 'winvplus-save');
  assert.equal(textSave.position, textItem.item.secondaryDelete.position);
  assert.equal(textSave.accessibilityText(), '添加到常用语');
  assert.equal(textSave.textLabel, undefined);
  assert.equal(textSave.getTooltipText(), undefined);
  await textSave.asyncHandler();
  assert.deepEqual(drainRequests(window), [{ action: 'add', id: 'clipboard-text-42' }]);
  assert.deepEqual(textItem.item.hideSecondaryCalls.map((options) => options.withAnimation), [false]);

  let nativeContextMenuCalls = 0;
  document.body.addEventListener('contextmenu', () => { nativeContextMenuCalls++; });
  const textEvent = dispatchContextMenu(window, textItem.label, 2);
  assert.equal(textEvent.defaultPrevented, true);
  assert.equal(nativeContextMenuCalls, 0);
  assert.equal(textItem.item.moreCalls, 1);
  assert.deepEqual(drainRequests(window), []);

  const imageItem = fixture.addImageHistoryItem('clipboard-image-7');
  await waitForMutationObserver(window);
  assert.deepEqual(imageItem.item.actions().map((action) => action.id), [
    'primary-more', 'secondary-delete', 'winvplus-save',
  ]);
  assert.ok(imageItem.item.preview.startsWith('data:image/png;base64,'));
  const imageSave = imageItem.item.actions().find((action) => action.id === 'winvplus-save');
  await imageSave.asyncHandler();
  assert.deepEqual(drainRequests(window), [{ action: 'add', id: 'clipboard-image-7' }]);
  assert.deepEqual(imageItem.item.hideSecondaryCalls.map((options) => options.withAnimation), [false]);
  assert.equal(textItem.item.actions().filter((action) => action.id === 'winvplus-save').length, 1);
});

test('renders favorites safely, supports keyboard paste, removes without pasting, and orders newest first', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const { window, document } = fixture;
  fixture.activate();
  drainRequests(window);

  const phraseText = '<img src=x onerror="window.injected=true">\n' + '长文字'.repeat(3000);
  const phrases = [
    { id: 'phrase-old', text: 'old phrase' },
    { id: 'phrase-1', text: phraseText },
    { id: 'phrase-image', type: 'image', preview: 'data:image/png;base64,aGVsbG8=' },
  ];
  window.__winvPlus.receive({ action: 'load', phrases });
  const cards = [...document.querySelectorAll('.winvplus-card')];
  assert.equal(cards.length, 3);
  const previewImage = cards[0].querySelector('img.clipboard-history-items-list-item-image');
  assert.ok(previewImage);
  assert.equal(previewImage.src, 'data:image/png;base64,aGVsbG8=');
  assert.equal(previewImage.alt, '保存的图片');
  assert.equal(cards[1].querySelector('.clipboard-history-items-list-item-text').textContent, phraseText);
  assert.equal(cards[2].querySelector('.clipboard-history-items-list-item-text').textContent, 'old phrase');

  const card = cards[1];
  const pasteControl = card.querySelector('.winvplus-paste');
  assert.ok(pasteControl);
  assert.equal(pasteControl.tagName, 'DIV');
  assert.equal(pasteControl.getAttribute('role'), 'button');
  const textSpan = pasteControl.querySelector('span.clipboard-history-items-list-item-text');
  assert.ok(textSpan);
  assert.equal(textSpan.textContent, phraseText);
  assert.equal(pasteControl.hasAttribute('title'), false);
  assert.equal(pasteControl.querySelector('img'), null);
  assert.equal(card.querySelector('.winvplus-more'), null);
  assert.equal(card.querySelector('.winvplus-secondary'), null);
  assert.equal(document.getElementById('winvplus-menu'), null);
  assert.equal(document.querySelector('body > img'), null);
  assert.equal(window.injected, undefined);

  pasteControl.click();
  assert.deepEqual(drainRequests(window), [{ action: 'paste', id: 'phrase-1' }]);

  for (const key of ['Enter', ' ']) {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    pasteControl.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(drainRequests(window), [{ action: 'paste', id: 'phrase-1' }]);
  }

  window.__winvPlus.receive({ action: 'paste' });
  await Promise.resolve();
  assert.equal(fixture.pasteCalls, 1);

  const remove = card.querySelector('.winvplus-remove');
  assert.ok(remove);
  assert.equal(remove.hasAttribute('title'), false);
  assert.equal(remove.getAttribute('role'), 'button');
  const list = document.querySelector('#winvplus-view .winvplus-list');
  const preservedImageCard = cards[0];
  const preservedImage = previewImage;
  list.scrollTop = 73;
  remove.querySelector('.winvplus-action-icon').click();
  assert.deepEqual(drainRequests(window), [{ action: 'remove', id: 'phrase-1' }]);
  assert.equal(fixture.pasteCalls, 1);
  window.__winvPlus.receive({ action: 'remove', phrases: [phrases[0], phrases[2]] });
  assert.equal(document.querySelectorAll('.winvplus-card').length, 2);
  assert.equal(document.querySelector('.winvplus-card img'), preservedImage);
  assert.equal(preservedImage.closest('.winvplus-card'), preservedImageCard);
  assert.equal(list.scrollTop, 73);

  const imageRemove = preservedImageCard.querySelector('.winvplus-remove');
  const enter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  imageRemove.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(drainRequests(window), [{ action: 'remove', id: 'phrase-image' }]);
  assert.equal(fixture.pasteCalls, 1);
  window.__winvPlus.receive({ action: 'remove', phrases: [phrases[0]] });

  const oldCard = document.querySelector('.winvplus-card');
  const space = new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  oldCard.querySelector('.winvplus-remove').dispatchEvent(space);
  assert.equal(space.defaultPrevented, true);
  assert.deepEqual(drainRequests(window), [{ action: 'remove', id: 'phrase-old' }]);
  assert.equal(fixture.pasteCalls, 1);
  window.__winvPlus.receive({ action: 'remove', phrases: [] });
  assert.equal(document.querySelectorAll('.winvplus-card').length, 0);
});

test('removing a phrase does not close a nested panel, but a native tab click does', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const { window, document, nav } = fixture;
  const content = document.getElementById('expanded-view-content');
  nav.appendChild(content);
  fixture.activate();
  drainRequests(window);
  window.__winvPlus.receive({ action: 'load', phrases: [{ id: 'nested-phrase', text: 'keep panel open' }] });

  const card = document.querySelector('.winvplus-card');
  const remove = card.querySelector('.winvplus-remove');
  const mousedown = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
  remove.dispatchEvent(mousedown);
  assert.equal(mousedown.defaultPrevented, true);
  remove.click();
  assert.deepEqual(drainRequests(window), [{ action: 'remove', id: 'nested-phrase' }]);
  assert.equal(fixture.pasteCalls, 0);
  assert.equal(window.__winvPlus.active, true);
  assert.equal(document.getElementById('winvplus-view').hidden, false);

  window.__winvPlus.receive({ action: 'remove', phrases: [] });
  assert.equal(window.__winvPlus.active, true);
  assert.equal(document.getElementById('winvplus-view').hidden, false);

  document.getElementById('navigation-menu-item-container-clipboard-history').click();
  assert.equal(window.__winvPlus.active, false);
  assert.equal(document.getElementById('winvplus-view').hidden, true);
});

test('reusing loaded phrases preserves card and image nodes', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const { window, document } = fixture;
  fixture.activate();
  drainRequests(window);
  const phrases = [
    { id: 'stable-text', text: 'same text' },
    { id: 'stable-image', type: 'image', preview: 'data:image/png;base64,c3RhYmxl' },
  ];
  window.__winvPlus.receive({ action: 'load', phrases });
  const cards = [...document.querySelectorAll('.winvplus-card')];
  const image = cards[0].querySelector('img');
  const list = document.querySelector('#winvplus-view .winvplus-list');
  list.scrollTop = 61;

  window.__winvPlus.receive({ action: 'load', phrases: phrases.map((phrase) => ({ ...phrase })) });

  assert.deepEqual([...document.querySelectorAll('.winvplus-card')], cards);
  assert.equal(document.querySelector('.winvplus-card img'), image);
  assert.equal(list.scrollTop, 61);
});

test('waits for native removal animation and storage confirmation in either order', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const { window, document } = fixture;
  fixture.activate();
  drainRequests(window);
  const phrases = [
    { id: 'tail', text: 'keep me' },
    { id: 'image', type: 'image', preview: 'data:image/png;base64,aW1hZ2U=' },
    { id: 'target', text: 'remove me' },
  ];
  window.__winvPlus.receive({ action: 'load', phrases });
  const list = document.querySelector('#winvplus-view .winvplus-list');
  const [targetCard, imageCard, tailCard] = [...list.querySelectorAll('.winvplus-card')];
  const image = imageCard.querySelector('img');
  list.scrollTop = 44;
  addRemovalAnimationStyle(document, '.333s');

  targetCard.querySelector('.winvplus-remove').click();
  assert.equal(window.getComputedStyle(tailCard).animationDuration, '.333s');
  assert.deepEqual(drainRequests(window), [{ action: 'remove', id: 'target' }]);
  assert.equal(fixture.pendingTimeoutCount, 1);
  assert.ok(targetCard.classList.contains('clipboard-history-items-list-item-remove-item-target-item'));
  assert.ok(imageCard.classList.contains('clipboard-history-items-list-item-remove-item-move-up-subsequent-item'));

  window.__winvPlus.receive({ action: 'remove', phrases: phrases.slice(0, 2) });
  assert.equal(targetCard.isConnected, true, 'storage confirmation alone must not remove the card');
  dispatchAnimationEnd(window, tailCard, 'unrelatedAnimation');
  assert.equal(targetCard.isConnected, true, 'an unrelated animation must be ignored');
  dispatchAnimationEnd(window, tailCard, 'clipboardHistoryRemoveItemMoveUpSubsequentItems');

  assert.equal(targetCard.isConnected, false);
  assert.equal(imageCard.isConnected, true);
  assert.equal(imageCard.querySelector('img'), image);
  assert.equal(list.scrollTop, 44);
  assert.equal(imageCard.classList.contains('clipboard-history-items-list-item-remove-item-move-up-subsequent-item'), false);
  assert.equal(tailCard.classList.contains('clipboard-history-items-list-item-remove-item-move-up-subsequent-item'), false);
  assert.equal(fixture.pendingTimeoutCount, 0);

  const nextTarget = imageCard;
  nextTarget.querySelector('.winvplus-remove').click();
  assert.deepEqual(drainRequests(window), [{ action: 'remove', id: 'image' }]);
  assert.equal(fixture.pendingTimeoutCount, 1);
  dispatchAnimationEnd(window, tailCard, 'clipboardHistoryRemoveItemMoveUpSubsequentItems');
  assert.equal(nextTarget.isConnected, true, 'animation completion alone must wait for storage confirmation');
  assert.equal(fixture.pendingTimeoutCount, 0);
  window.__winvPlus.receive({ action: 'remove', phrases: [phrases[0]] });
  assert.equal(nextTarget.isConnected, false);
  assert.equal(tailCard.isConnected, true);
});

test('restores a failed removal, completes with animations disabled, and dispose cancels pending removal', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const { window, document } = fixture;
  fixture.activate();
  drainRequests(window);
  const phrases = [
    { id: 'following', type: 'image', preview: 'data:image/png;base64,Zm9sbG93' },
    { id: 'failed', text: 'keep after error' },
  ];
  window.__winvPlus.receive({ action: 'load', phrases });
  const list = document.querySelector('#winvplus-view .winvplus-list');
  const [failedCard, followingCard] = [...list.querySelectorAll('.winvplus-card')];
  addRemovalAnimationStyle(document, '.333s');

  failedCard.querySelector('.winvplus-remove').click();
  assert.deepEqual(drainRequests(window), [{ action: 'remove', id: 'failed' }]);
  assert.equal(fixture.pendingTimeoutCount, 1);
  window.__winvPlus.receive({ action: 'remove', error: 'save failed' });
  assert.equal(failedCard.isConnected, true);
  assert.equal(list.querySelectorAll('.winvplus-card').length, 2);
  assert.equal(failedCard.classList.contains('clipboard-history-items-list-item-remove-item-target-item'), false);
  assert.equal(failedCard.querySelector('.winvplus-remove').hasAttribute('aria-disabled'), false);
  assert.equal(followingCard.classList.contains('clipboard-history-items-list-item-remove-item-move-up-subsequent-item'), false);
  assert.equal(document.querySelector('#winvplus-view .winvplus-status').textContent, 'save failed');
  assert.equal(fixture.pendingTimeoutCount, 0);

  addRemovalAnimationStyle(document, '0s');
  failedCard.querySelector('.winvplus-remove').click();
  assert.deepEqual(drainRequests(window), [{ action: 'remove', id: 'failed' }]);
  assert.equal(fixture.pendingTimeoutCount, 0, 'zero-duration animation should finish immediately');
  assert.equal(failedCard.isConnected, true, 'zero-duration animation still waits for storage confirmation');
  window.__winvPlus.receive({ action: 'remove', phrases: [phrases[0]] });
  assert.equal(failedCard.isConnected, false);
  assert.equal(followingCard.isConnected, true);

  addRemovalAnimationStyle(document, '.333s');
  const animationListeners = instrumentElementListeners(followingCard, 'animationend');
  followingCard.querySelector('.winvplus-remove').click();
  assert.deepEqual(drainRequests(window), [{ action: 'remove', id: 'following' }]);
  assert.equal(fixture.pendingTimeoutCount, 1);
  assert.equal(animationListeners.count(), 1);
  const oldState = window.__winvPlus;
  oldState.dispose();
  assert.equal(fixture.pendingTimeoutCount, 0);
  assert.equal(animationListeners.count(), 0);
  assert.equal(followingCard.isConnected, false, 'dispose removes the panel while canceling its pending operation');
  dispatchAnimationEnd(window, followingCard, 'clipboardHistoryRemoveItemTargetItemShrink');
  assert.equal(followingCard.classList.contains('clipboard-history-items-list-item-remove-item-target-item'), true);
  assert.equal(fixture.pendingTimeoutCount, 0);
});

test('hiding restores native history and right-clicking a favorite has no side effect', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const { window, document, root, clipboard } = fixture;
  const nativeList = document.getElementById('expanded-view-content-lists');
  fixture.activate();
  drainRequests(window);
  window.__winvPlus.receive({ action: 'load', phrases: [{ id: 'phrase-context-1', text: 'saved phrase' }] });

  const card = document.querySelector('.winvplus-card');
  assert.equal(card.querySelector('.winvplus-more'), null);
  assert.equal(card.querySelector('.winvplus-secondary'), null);
  assert.equal(document.getElementById('winvplus-menu'), null);
  const contextEvent = dispatchContextMenu(window, card, 2);
  assert.equal(contextEvent.defaultPrevented, true);
  assert.deepEqual(drainRequests(window), []);
  assert.equal(fixture.pasteCalls, 0);

  assert.equal(document.body.classList.contains('winvplus-phrases-open'), true);
  assert.equal(window.getComputedStyle(nativeList).display, 'none');

  root.isLastShowHideEventShow(false);
  assert.equal(window.__winvPlus.active, false);
  assert.equal(document.body.classList.contains('winvplus-phrases-open'), false);
  assert.equal(document.getElementById('winvplus-view').hidden, true);
  assert.notEqual(window.getComputedStyle(nativeList).display, 'none');
  assert.equal(clipboard.isSelected(), true);

  root.isLastShowHideEventShow(true);
  fixture.activate();
  assert.equal(window.__winvPlus.active, true);
  assert.equal(clipboard.isSelected(), false);
  assert.deepEqual(drainRequests(window), [{ revision: '', action: 'load' }]);
  assert.deepEqual(drainRequests(window), []);
});

test('dispose removes native actions and observer, then reinstall adds each action once', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const { window, document, nav, root } = fixture;
  fixture.activate();
  drainRequests(window);

  const firstItem = fixture.addTextHistoryItem('clipboard-before-dispose', 'before dispose');
  await waitForMutationObserver(window);
  assert.equal(firstItem.item.actions().filter((action) => action.id === 'winvplus-save').length, 1);

  assert.ok(document.getElementById('winvplus-view'));
  assert.equal(document.getElementById('winvplus-menu'), null);
  assert.ok(document.getElementById('winvplus-style'));
  assert.equal(root.customNavigationMenuClickHandlers.length, 1);
  assert.equal(fixture.navigationListeners.count('click'), 0);
  assert.equal(fixture.documentListeners.total(), 1);
  assert.equal(fixture.documentListeners.count('contextmenu'), 1);
  assert.equal(fixture.documentListeners.count('pointerdown'), 0);
  assert.equal(fixture.documentListeners.count('keydown'), 0);

  const oldState = window.__winvPlus;
  oldState.dispose();
  assert.equal(window.__winvPlus, undefined);
  assert.equal(document.getElementById('winvplus-view'), null);
  assert.equal(document.getElementById('winvplus-style'), null);
  assert.equal(root.customNavigationMenuClickHandlers.length, 0);
  assert.equal(fixture.navigationListeners.count('click'), 0);
  assert.equal(fixture.documentListeners.total(), 0);
  assert.equal(fixture.documentListeners.count('contextmenu'), 0);
  assert.equal(firstItem.item.actions().some((action) => action.id === 'winvplus-save'), false);

  const afterDispose = fixture.addImageHistoryItem('clipboard-after-dispose');
  await waitForMutationObserver(window);
  assert.equal(afterDispose.item.actions().some((action) => action.id === 'winvplus-save'), false);
  const eventAfterDispose = dispatchContextMenu(window, afterDispose.image, 2);
  assert.equal(eventAfterDispose.defaultPrevented, false);
  assert.equal(afterDispose.item.moreCalls, 0);

  fixture.inject();
  assert.notEqual(window.__winvPlus, oldState);
  assert.equal(window.__winvPlus.ready, true);
  assert.equal(document.querySelectorAll('#navigation-menu-item-container-winvplus-phrases').length, 1);
  assert.equal(root.customNavigationMenuClickHandlers.length, 1);
  assert.equal(fixture.navigationListeners.count('click'), 0);
  assert.equal(fixture.documentListeners.total(), 1);
  assert.equal(fixture.documentListeners.count('contextmenu'), 1);
  assert.equal(fixture.documentListeners.count('pointerdown'), 0);
  assert.equal(fixture.documentListeners.count('keydown'), 0);
  assert.ok(nav.contains(document.getElementById('navigation-menu-item-container-winvplus-phrases')));
  assert.equal(firstItem.item.actions().filter((action) => action.id === 'winvplus-save').length, 1);
  assert.equal(afterDispose.item.actions().filter((action) => action.id === 'winvplus-save').length, 1);
  await waitForMutationObserver(window);
  assert.equal(firstItem.item.actions().filter((action) => action.id === 'winvplus-save').length, 1);
  assert.equal(afterDispose.item.actions().filter((action) => action.id === 'winvplus-save').length, 1);
});

test('large saved collections create only a page of cards and keep previews across reopen', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const { window, document, root } = fixture;
  assert.deepEqual(drainRequests(window), [], 'native clipboard opens without loading favorites');
  fixture.activate();
  assert.deepEqual(drainRequests(window), [{ action: 'load', revision: '' }]);
  const phrases = Array.from({ length: 3000 }, (_, i) => ({
    id: `large-${i}`, type: 'image', preview: 'data:image/png;base64,c21hbGw=',
  }));
  window.__winvPlus.receive({ action: 'load', phrases, revision: 'disk-v1' });
  assert.equal(document.querySelectorAll('.winvplus-card').length, 24);
  const first = document.querySelector('.winvplus-card');
  const image = first.querySelector('img');
  assert.equal(image.getAttribute('loading'), 'lazy');
  assert.equal(image.getAttribute('decoding'), 'async');
  first.querySelector('.winvplus-paste').click();
  assert.deepEqual(drainRequests(window), [{ action: 'paste', id: 'large-2999' }]);
  document.querySelector('.winvplus-more').click();
  assert.equal(document.querySelectorAll('.winvplus-card').length, 48);
  assert.equal(document.querySelector('.winvplus-card img'), image);
  root.isLastShowHideEventShow(false);
  root.isLastShowHideEventShow(true);
  fixture.activate();
  window.__winvPlus.refresh();
  assert.deepEqual(drainRequests(window), [{ action: 'load', revision: 'disk-v1' }], 'one validation request, no duplicate full load');
  window.__winvPlus.receive({ action: 'load', revision: 'disk-v1' });
  assert.equal(document.querySelectorAll('.winvplus-card').length, 48);
  assert.equal(document.querySelector('.winvplus-card img'), image);
});

test('hundreds of native records and action mutations do not rescan the whole list', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const { window, document } = fixture;
  let fullScans = 0;
  const query = document.querySelectorAll.bind(document);
  document.querySelectorAll = (selector) => {
    if (selector === '#expanded-view-content-lists li.clipboard-history-items-list-item') fullScans++;
    return query(selector);
  };
  const items = Array.from({ length: 300 }, (_, i) => fixture.addTextHistoryItem(`native-${i}`, `text ${i}`));
  await waitForMutationObserver(window);
  await waitForMutationObserver(window);
  assert.equal(fullScans, 0);
  for (const { item } of items) assert.equal(item.actions().filter((a) => a.id === 'winvplus-save').length, 1);
  items[0].card.remove();
  await waitForMutationObserver(window);
  assert.equal(items[0].item.actions().some((a) => a.id === 'winvplus-save'), false);
  assert.equal(items[1].item.actions().filter((a) => a.id === 'winvplus-save').length, 1);
  assert.equal(fullScans, 0);
});

test('history cache reuses loaded native rows and invalidates on hidden history changes', async (t) => {
  let harness;
  const fixture = createFixture((context) => { harness = createHistoryCacheHarness(context); });
  t.after(() => fixture.dom.window.close());
  const { window, document, root } = fixture;

  assert.equal(window.__winvPlus.historyCache.enabled, true);
  assert.equal(harness.calls.initialize, 2, 'native source and cache each install one subscription');
  assert.equal(await harness.openHistory(), true, 'first open must fetch');
  assert.equal(harness.calls.fetches, 1);
  const list = document.getElementById('expanded-view-content-lists');
  const firstNode = list.firstElementChild;
  assert.ok(firstNode);

  assert.equal(await harness.openHistory(), false, 'a clean cache skips the native refresh');
  assert.equal(harness.calls.fetches, 1);
  assert.equal(list.firstElementChild, firstNode, 'cache hit preserves the native list node');
  assert.equal(harness.calls.initialize, 2, 'opening again must not register another listener');

  root.isLastShowHideEventShow(false);
  assert.equal(harness.nativeListeners.size, 1, 'the native view listener stops while hidden');
  await harness.fireHistoryChanged();
  assert.equal(harness.calls.nativeChanges, 0, 'native view listener missed the hidden change');
  assert.equal(JSON.parse(window.__winvPlus.drain().historyCache).changes, 1,
    'cache invalidation listener remains active while hidden');

  root.isLastShowHideEventShow(true);
  assert.equal(await harness.openHistory(), true, 'hidden-time changes force a refresh on reopen');
  assert.equal(harness.calls.fetches, 2);
  assert.notEqual(list.firstElementChild, firstNode, 'successful refresh rebuilds the native list');
  assert.equal(await harness.openHistory(), false, 'successful refresh restores cache hits');
  assert.equal(harness.calls.fetches, 2);
});

test('history cache keeps invalidations during fetches and retries failed or empty results', async (t) => {
  let harness;
  const fixture = createFixture((context) => { harness = createHistoryCacheHarness(context); });
  t.after(() => fixture.dom.window.close());
  const { window } = fixture;
  let resolveFetch;
  harness.setFetchHandler(() => new Promise((resolve) => { resolveFetch = resolve; }));

  const opening = harness.openHistory();
  await Promise.resolve();
  await harness.fireHistoryChanged();
  resolveFetch({ items: [{ id: 'fetched-before-event' }] });
  await opening;
  assert.equal(harness.source.isDataRefreshNecessary(), true,
    'a change after fetch start must not be cleared by that fetch completing');

  harness.setFetchHandler(() => Promise.resolve({ items: [{ id: 'after-event' }] }));
  assert.equal(await harness.openHistory(), true);
  assert.equal(harness.source.isDataRefreshNecessary(), false);

  await harness.fireHistoryChanged();
  harness.pendingResults.push(() => Promise.reject(new Error('native fetch failed')));
  await assert.rejects(harness.openHistory(), /native fetch failed/);
  assert.equal(harness.source.isDataRefreshNecessary(), true, 'failed results stay stale');
  assert.equal(await harness.openHistory(), true, 'a failed fetch is retried');

  await harness.fireHistoryChanged();
  harness.pendingResults.push(() => Promise.resolve({ items: [] }));
  assert.equal(await harness.openHistory(), true);
  assert.equal(harness.source.isDataRefreshNecessary(), true, 'empty history is not cached as complete');
  assert.equal(await harness.openHistory(), true, 'empty history is retried on the next open');
  assert.equal(harness.calls.fetches, 6);
  assert.equal(harness.source.isDataRefreshNecessary(), false);
  assert.equal(JSON.parse(window.__winvPlus.drain().historyCache).fetches, 6);
});

test('history cache expires after five minutes and dispose restores the native source', async (t) => {
  let harness;
  const fixture = createFixture((context) => { harness = createHistoryCacheHarness(context); });
  t.after(() => fixture.dom.window.close());
  const { window } = fixture;
  const originalFetch = harness.originalFetch;
  const originalRefresh = harness.originalRefresh;
  let now = 10_000;
  window.Date.now = () => now;

  assert.equal(await harness.openHistory(), true);
  assert.equal(await harness.openHistory(), false);
  now += 300_001;
  assert.equal(await harness.openHistory(), true, 'the five-minute safety timeout refreshes history');
  assert.equal(harness.calls.fetches, 2);

  window.__winvPlus.dispose();
  assert.equal(harness.source.fetchAsync, originalFetch);
  assert.equal(harness.source.isDataRefreshNecessary, originalRefresh);
  assert.equal(harness.nativeListeners.size, 1, 'dispose removes only its own listener');
  const changes = JSON.parse(window.__winvPlus?.drain?.().historyCache || '{}').changes;
  await harness.fireHistoryChanged();
  assert.equal(harness.calls.nativeChanges, 1, 'native listener still works after cache disposal');
  assert.equal(changes, undefined, 'disposed cache state is no longer exposed');

  window.__winvPlus = undefined;
  fixture.inject();
  assert.equal(harness.calls.initialize, 3, 'reinstall registers one fresh cache listener');
  assert.equal(harness.nativeListeners.size, 2);
  window.__winvPlus.dispose();
  assert.equal(harness.nativeListeners.size, 1, 'repeated dispose leaves no cache listener behind');
});

test('history pager builds native first-page rows, appends pages, and keeps Clear All bound to full history', async (t) => {
  let harness;
  const fixture = createFixture((context) => { harness = createHistoryPagerHarness(context); });
  t.after(() => fixture.dom.window.close());
  const { window, document } = fixture;

  assert.equal(await harness.openHistory(), true);
  const list = harness.lists()[0];
  const firstNode = list.__nodes.get('native-1');
  assert.equal(list.items().length, 10, 'the native binding constructs only the first ten rows');
  assert.ok(firstNode?.isConnected);
  assert.equal(window.__winvPlus.historyCache.total, 300);
  const clearAll = list.listActions[0];
  assert.equal(clearAll.isEnabled(), true, 'the eleventh full-snapshot model enables native Clear All');
  await clearAll.asyncHandler();
  assert.equal(harness.calls.clearAll, 1, 'the native Clear All handler remains intact');

  const button = document.querySelector('.winvplus-history-more');
  assert.ok(button);
  button.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(list.items().length, 20);
  assert.equal(list.__nodes.get('native-1'), firstNode, 'page append preserves existing native nodes');

  harness.content.scrollTop = 500;
  harness.content.dispatchEvent(new window.Event('scroll'));
  await flushAsync();
  assert.equal(list.items().length, 30, 'scrolling near the footer loads another page');

  fixture.root.isLastShowHideEventShow(false);
  fixture.root.isLastShowHideEventShow(true);
  let resolveTail;
  harness.setFetchHandler(() => new Promise((resolve) => { resolveTail = resolve; }));
  button.click();
  button.click();
  await flushAsync();
  assert.equal(harness.calls.fetches, 2, 'concurrent tail clicks share one native fetch');
  resolveTail({ items: harness.models.slice() });
  await flushAsync();
  assert.equal(list.items().length, 20, 'overlapping button clicks append one page only after hide resets the span');
});

test('history pager releases tail models on hide, reloads tail on demand, and retries failed pages', async (t) => {
  let harness;
  const fixture = createFixture((context) => { harness = createHistoryPagerHarness(context); });
  t.after(() => fixture.dom.window.close());
  const { window, document, root } = fixture;
  await harness.openHistory();
  const list = harness.lists()[0];
  document.querySelector('.winvplus-history-more').click();
  await flushAsync();
  assert.equal(list.items().length, 20);

  root.isLastShowHideEventShow(false);
  assert.equal(list.items().length, 10, 'hiding trims the native observable list to its head page');
  assert.ok(harness.calls.cleanup.at(-1).length <= 20, 'thumbnail cleanup receives only retained head models');
  root.isLastShowHideEventShow(true);
  assert.equal(await harness.openHistory(), false, 'reopening hits the cached first page');
  assert.equal(harness.calls.fetches, 1);
  document.querySelector('.winvplus-history-more').click();
  await flushAsync();
  assert.equal(list.items().length, 20, 'paging after release fetches and appends the tail again');
  assert.equal(harness.calls.fetches, 2);

  root.isLastShowHideEventShow(false);
  root.isLastShowHideEventShow(true);
  await harness.openHistory();
  harness.pendingResults.push(() => Promise.reject(new Error('tail page failed')));
  document.querySelector('.winvplus-history-more').click();
  await flushAsync();
  assert.equal(list.items().length, 10, 'failed tail fetch leaves the head visible');
  assert.equal(window.__winvPlus.historyCache.enabled, true, 'tail failure does not invalidate the head cache');
  document.querySelector('.winvplus-history-more').click();
  await flushAsync();
  assert.equal(list.items().length, 20, 'a failed tail fetch can be retried');
});

test('history pager drops in-flight pages after change, navigation, or hide and disposes its UI hooks', async (t) => {
  let harness;
  const fixture = createFixture((context) => { harness = createHistoryPagerHarness(context); });
  t.after(() => fixture.dom.window.close());
  const { window, document, root } = fixture;
  await harness.openHistory();
  const list = harness.lists()[0];
  const button = document.querySelector('.winvplus-history-more');
  let resolveTail;
  harness.setFetchHandler(() => new Promise((resolve) => { resolveTail = resolve; }));

  root.isLastShowHideEventShow(false);
  root.isLastShowHideEventShow(true);
  button.click();
  await flushAsync();
  await harness.fireHistoryChanged();
  resolveTail({ items: harness.models.slice() });
  await flushAsync();
  assert.equal(list.items().length, 10, 'a generation change prevents a stale append');

  harness.setFetchHandler(() => Promise.resolve({ items: harness.models.slice() }));
  // Refresh native history, then defer another page while changing views.
  assert.equal(await harness.openHistory(), true);
  const currentList = harness.lists()[0];
  const currentButton = document.querySelector('.winvplus-history-more');
  harness.setFetchHandler(() => new Promise((resolve) => { resolveTail = resolve; }));
  root.isLastShowHideEventShow(false);
  root.isLastShowHideEventShow(true);
  currentButton.click();
  await flushAsync();
  root.currentViewId('settings');
  resolveTail({ items: harness.models.slice() });
  await flushAsync();
  assert.equal(currentList.items().length, 10, 'navigation prevents a stale append');

  root.currentViewId('clipboard-history');
  root.isLastShowHideEventShow(false);
  root.isLastShowHideEventShow(true);
  harness.setFetchHandler(() => new Promise((resolve) => { resolveTail = resolve; }));
  document.querySelector('.winvplus-history-more').click();
  await flushAsync();
  root.isLastShowHideEventShow(false);
  resolveTail({ items: harness.models.slice() });
  await flushAsync();
  assert.equal(currentList.items().length, 10, 'hiding prevents an in-flight tail append');

  window.__winvPlus.dispose();
  assert.equal(document.querySelector('.winvplus-history-footer'), null);
  assert.equal(harness.creator.create, harness.originalCreate, 'dispose restores the native action creator');
  const fetches = harness.calls.fetches;
  button.click();
  harness.content.scrollTop = 500;
  harness.content.dispatchEvent(new window.Event('scroll'));
  assert.equal(harness.calls.fetches, fetches, 'disposed controls no longer initiate page loads');
  assert.equal(harness.source.isDataRefreshNecessary, harness.originalRefresh);
});
