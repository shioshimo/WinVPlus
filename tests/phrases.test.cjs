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
  const inject = () => vm.runInNewContext(source, {
    window,
    document,
    ko,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
  }, { filename: 'phrases.js' });
  inject();

  function addTextHistoryItem(id, text) {
    const card = document.createElement('li');
    card.className = 'expanded-view-list-item';
    card.setAttribute('role', 'row');
    const content = document.createElement('div');
    content.className = 'clipboard-history-items-list-item-content';
    content.setAttribute('role', 'cell');
    const label = document.createElement('span');
    label.className = 'clipboard-history-items-list-item-text';
    label.textContent = text;
    content.appendChild(label);
    card.appendChild(content);
    document.getElementById('expanded-view-content-lists').appendChild(card);
    dataByElement.set(card, { id, isClipboardItem: true, label: text });
    return { card, label };
  }

  function addImageHistoryItem(id) {
    const card = document.createElement('li');
    card.className = 'expanded-view-list-item expanded-view-list-item-media';
    card.setAttribute('role', 'row');
    const content = document.createElement('div');
    content.className = 'clipboard-history-items-list-item-content';
    const frame = document.createElement('div');
    frame.className = 'clipboard-history-items-list-item-imageframe';
    const image = document.createElement('img');
    image.className = 'clipboard-history-items-list-item-image';
    frame.appendChild(image);
    content.appendChild(frame);
    card.appendChild(content);
    document.getElementById('expanded-view-content-lists').appendChild(card);
    dataByElement.set(card, { id, isClipboardItem: true });
    return { card, image };
  }

  return {
    dom, window, document, root, navModel, nav, clipboard,
    visibilityUpdates, documentListeners, navigationListeners,
    inject, addTextHistoryItem, addImageHistoryItem,
    get pasteCalls() { return pasteCalls; },
    activate() {
      document.getElementById('navigation-menu-item-container-winvplus-phrases').click();
      assert.equal(window.__winvPlus.active, true);
    },
  };
}

function dispatchContextMenu(window, target) {
  const event = new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 30, clientY: 40,
  });
  target.dispatchEvent(event);
  return event;
}

function drainRequests(window) {
  return JSON.parse(JSON.stringify(window.__winvPlus.drain().requests));
}

test('adds one native tab, adds text and image records by id, and renders image previews', (t) => {
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
  const textEvent = dispatchContextMenu(window, textItem.label);
  assert.equal(textEvent.defaultPrevented, true);
  const addAction = document.querySelector('#winvplus-menu [role="menuitem"]');
  assert.ok(addAction);
  assert.equal(addAction.textContent, '添加到常用语');
  addAction.click();
  assert.deepEqual(drainRequests(window), [
    { action: 'add', id: 'clipboard-text-42' },
  ]);

  const imageItem = fixture.addImageHistoryItem('clipboard-image-7');
  const imageEvent = dispatchContextMenu(window, imageItem.image);
  assert.equal(imageEvent.defaultPrevented, true);
  const imageAddAction = document.querySelector('#winvplus-menu [role="menuitem"]');
  assert.ok(imageAddAction);
  assert.equal(imageAddAction.textContent, '添加到常用语');
  imageAddAction.click();
  assert.deepEqual(drainRequests(window), [
    { action: 'add', id: 'clipboard-image-7' },
  ]);

  const preview = 'data:image/png;base64,aGVsbG8=';
  window.__winvPlus.receive({ phrases: [{ id: 'clipboard-image-7', type: 'image', preview }] });
  const imagePhrase = document.querySelector('.winvplus-card .winvplus-paste');
  const previewImage = imagePhrase.querySelector('img.clipboard-history-items-list-item-image');
  assert.ok(previewImage);
  assert.equal(previewImage.src, preview);
  assert.equal(previewImage.alt, '保存的图片');
  assert.equal(imagePhrase.getAttribute('role'), 'button');
  assert.equal(imagePhrase.querySelector('.clipboard-history-items-list-item-text'), null);
});

test('renders text safely, supports keyboard paste, keeps remove separate, and uses legacy menu hover selectors', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const { window, document } = fixture;
  fixture.activate();
  drainRequests(window);

  const phraseText = '<img src=x onerror="window.injected=true">\n' + '长文字'.repeat(3000);
  window.__winvPlus.receive({ phrases: [{ id: 'phrase-1', text: phraseText }] });
  const pasteControl = document.querySelector('.winvplus-card .winvplus-paste');
  assert.ok(pasteControl);
  assert.equal(pasteControl.tagName, 'DIV');
  assert.equal(pasteControl.getAttribute('role'), 'button');
  const textSpan = pasteControl.querySelector('span.clipboard-history-items-list-item-text');
  assert.ok(textSpan);
  assert.equal(textSpan.textContent, phraseText);
  assert.equal(pasteControl.title, phraseText);
  assert.equal(pasteControl.querySelector('img'), null);
  assert.equal(document.querySelector('body > img'), null);
  assert.equal(window.injected, undefined);

  pasteControl.click();
  assert.deepEqual(drainRequests(window), [
    { action: 'paste', id: 'phrase-1' },
  ]);

  for (const key of ['Enter', ' ']) {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    pasteControl.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(drainRequests(window), [
      { action: 'paste', id: 'phrase-1' },
    ]);
  }

  window.__winvPlus.receive({ action: 'paste' });
  await Promise.resolve();
  assert.equal(fixture.pasteCalls, 1);

  document.querySelector('.winvplus-card .winvplus-more').click();
  const removeAction = document.querySelector('#winvplus-menu [role="menuitem"]');
  assert.ok(removeAction);
  assert.equal(removeAction.textContent, '移出常用语');
  const style = document.getElementById('winvplus-style').textContent;
  assert.match(style, /\.winvplus-menu-item:hover,\.winvplus-menu-item\.winvplus-hover/);
  assert.equal(style.includes(':focus-visible'), false);
  removeAction.dispatchEvent(new window.Event('pointerenter'));
  assert.equal(removeAction.classList.contains('winvplus-hover'), true);
  removeAction.dispatchEvent(new window.Event('pointerleave'));
  assert.equal(removeAction.classList.contains('winvplus-hover'), false);
  removeAction.click();
  assert.deepEqual(drainRequests(window), [
    { action: 'remove', id: 'phrase-1' },
  ]);
});

test('dispose removes UI and event handlers, then the script can install again', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.dom.window.close());
  const { window, document, nav, root } = fixture;
  fixture.activate();

  assert.ok(document.getElementById('winvplus-view'));
  assert.ok(document.getElementById('winvplus-menu'));
  assert.equal(document.getElementById('winvplus-toast'), null);
  assert.ok(document.getElementById('winvplus-style'));
  assert.equal(root.customNavigationMenuClickHandlers.length, 1);
  assert.equal(fixture.navigationListeners.count('click'), 1);
  assert.equal(fixture.documentListeners.total(), 3);

  const oldState = window.__winvPlus;
  oldState.dispose();
  assert.equal(window.__winvPlus, undefined);
  assert.equal(document.getElementById('winvplus-view'), null);
  assert.equal(document.getElementById('winvplus-menu'), null);
  assert.equal(document.getElementById('winvplus-toast'), null);
  assert.equal(document.getElementById('winvplus-style'), null);
  assert.equal(document.getElementById('navigation-menu-item-container-winvplus-phrases'), null);
  assert.equal(root.customNavigationMenuClickHandlers.length, 0);
  assert.equal(fixture.navigationListeners.count('click'), 0);
  assert.equal(fixture.documentListeners.total(), 0);

  const item = fixture.addTextHistoryItem('clipboard-after-dispose', 'after dispose');
  const eventAfterDispose = dispatchContextMenu(window, item.label);
  assert.equal(eventAfterDispose.defaultPrevented, false);

  fixture.inject();
  assert.notEqual(window.__winvPlus, oldState);
  assert.equal(window.__winvPlus.ready, true);
  assert.equal(document.querySelectorAll('#navigation-menu-item-container-winvplus-phrases').length, 1);
  assert.equal(root.customNavigationMenuClickHandlers.length, 1);
  assert.equal(fixture.navigationListeners.count('click'), 1);
  assert.equal(fixture.documentListeners.total(), 3);
  assert.ok(nav.contains(document.getElementById('navigation-menu-item-container-winvplus-phrases')));
});
