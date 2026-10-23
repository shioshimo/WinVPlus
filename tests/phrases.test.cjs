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

function createFixture() {
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

function waitForMutationObserver(window) {
  return new Promise((resolve) => window.queueMicrotask(resolve));
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
  assert.deepEqual(drainRequests(window), [{ action: 'load', revision: '' }]);
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
