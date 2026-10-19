(function () {
  'use strict';
  if (window.__winvPlus) { window.__winvPlus.refresh(); return; }

  var S = { phrases: [], active: false, ready: false, disposed: false, subs: [], outbox: [], error: '', menuClicks: 0, scriptError: '', lastEvent: '' };
  window.__winvPlus = S;
  var root, navItem, navHandler, view, list, status, observer, selectedBefore = [], nativeItems = [];
  var saveActionId = 'winvplus-save';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function send(action, extra) {
    var message = extra || {};
    message.action = action;
    S.outbox.push(message);
  }
  S.drain = function () {
    return {
      visible: !root || !ko.isObservable(root.isLastShowHideEventShow) || root.isLastShowHideEventShow(),
      menuClicks: S.menuClicks,
      uiState: JSON.stringify({active:S.active,event:S.lastEvent,error:S.scriptError,visible:root && ko.unwrap(root.isLastShowHideEventShow),viewId:root && ko.unwrap(root.currentViewId),nav:rootNav() ? rootNav().offsetHeight : -1,view:view ? view.offsetHeight : -1}),
      requests: S.outbox.splice(0)
    };
  };
  function tell(text) {
    if (!status) return;
    status.textContent = text;
    status.setAttribute('role', 'status');
  }
  function setActive(active) {
    if (S.active === active) return;
    S.active = active;
    document.body.classList.toggle('winvplus-phrases-open', active);
    navItem.isSelected(active);
    view.hidden = !active;
    if (active) {
      selectedBefore = [];
      ko.unwrap(root.navigationMenuViewModel.navigationMenuItems).forEach(function (item) {
        if (item !== navItem && ko.unwrap(item.isSelected)) { selectedBefore.push(item); item.isSelected(false); }
      });
      send('load');
      render();
    } else {
      selectedBefore.forEach(function (item) { item.isSelected(item.id === ko.unwrap(root.currentViewId)); });
      selectedBefore = [];
    }
  }
  function render() {
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!S.phrases.length) {
      var empty = el('div', 'winvplus-empty');
      empty.appendChild(el('div', 'winvplus-empty-icon', '\uE734'));
      empty.appendChild(el('p', '', '右键剪贴板记录，添加到这里'));
      list.appendChild(empty);
    }
    S.phrases.slice().reverse().forEach(function (phrase) {
      var card = el('li', 'expanded-view-list-item clipboard-history-items-list-item winvplus-card');
      var paste = el('div', 'clipboard-history-items-list-item-content winvplus-paste');
      paste.tabIndex = 0;
      paste.setAttribute('role', 'button');
      paste.setAttribute('aria-label', '粘贴：' + (phrase.text || '图片'));
      if (phrase.type === 'image') {
        var frame = el('div', 'clipboard-history-items-list-item-imageframe');
        var image = el('img', 'clipboard-history-items-list-item-image');
        image.src = phrase.preview; image.alt = '保存的图片';
        frame.appendChild(image); paste.appendChild(frame);
      } else paste.appendChild(el('span', 'clipboard-history-items-list-item-text', phrase.text));
      paste.addEventListener('click', function (e) { e.stopPropagation(); send('paste', { id: phrase.id }); });
      paste.addEventListener('keydown', function (e) {
        if (e.target === paste && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); paste.click(); }
      });
      var actions = el('ul', 'clipboard-history-items-list-item-actions-primary-view');
      var remove = el('li', 'clipboard-history-items-list-item-action winvplus-remove');
      remove.tabIndex = 0; remove.setAttribute('role', 'button'); remove.setAttribute('aria-label', '移出常用语');
      remove.appendChild(el('span', 'clipboard-history-items-list-item-action-icon winvplus-action-icon', '\uE74D'));
      remove.addEventListener('click', function (e) { e.stopPropagation(); ++S.menuClicks; S.lastEvent = 'remove'; send('remove', { id: phrase.id }); });
      remove.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); remove.click(); }
      });
      actions.appendChild(remove); paste.appendChild(actions); card.appendChild(paste); list.appendChild(card);
    });
    tell(S.error || (S.phrases.length ? S.phrases.length + ' 条' : ''));
  }
  // Extend the native observable action list. Windows owns rendering and interaction.
  function addNativeAction(item) {
    if (!item || !ko.isObservable(item.actions)) return;
    var actions = ko.unwrap(item.actions);
    if (!actions.length || actions.some(function (action) { return action.id === saveActionId; })) return;
    var Action = actions[0].constructor;
    var secondaryPosition = actions[actions.length - 1].position;
    var save = new Action({
      id: saveActionId, position: secondaryPosition, label: '&#xe734;',
      labelFont: 'Segoe Fluent Icons, Segoe MDL2 Assets', accessibilityText: ko.observable('添加到常用语')
    }, function () {
      ++S.menuClicks; S.lastEvent = 'save-native-action'; send('add', { id: item.id });
      return item.hideSecondaryViewAsync({ withAnimation: false });
    });
    save.getTooltipText = function () { return undefined; };
    item.actions(actions.concat([save]));
    nativeItems.push(item);
  }
  function scanHistory() {
    var visibleItems = [];
    document.querySelectorAll('#expanded-view-content-lists li.clipboard-history-items-list-item').forEach(function (card) {
      var item = ko.dataFor(card);
      if (item) { visibleItems.push(item); addNativeAction(item); }
    });
    nativeItems = nativeItems.filter(function (item) {
      if (visibleItems.indexOf(item) >= 0) return true;
      item.actions(ko.unwrap(item.actions).filter(function (action) { return action.id !== saveActionId; }));
      return false;
    });
  }
  function onContext(e) {
    if (S.active) {
      var saved = e.target.closest && e.target.closest('.winvplus-card');
      if (saved) {
        e.preventDefault(); e.stopPropagation();
      }
      return;
    }
    var card = e.target.closest && e.target.closest('li.expanded-view-list-item');
    if (!card || !card.querySelector('.clipboard-history-items-list-item-text,.clipboard-history-items-list-item-image')) return;
    var item = ko.dataFor(card);
    if (!item || !item.id || !ko.isObservable(item.actions)) return;
    e.preventDefault(); e.stopPropagation();
    addNativeAction(item);
    var more = card.querySelector('.clipboard-history-items-list-item-actions-primary-view .clipboard-history-items-list-item-action');
    if (more) more.click();
  }
  function onNav(e) {
    var tab = document.getElementById(navItem.containerHtmlId);
    if (!tab || !tab.contains(e.target)) setActive(false);
  }
  function onScriptError(e) { S.scriptError = e.message || String(e.reason || e.error || 'Unknown script error'); }
  S.receive = function (message) {
    if (message.error) { S.error = message.error; tell(message.error); return; }
    if (message.action !== 'load') S.error = '';
    if (message.phrases) { S.phrases = message.phrases; render(); }
    if (message.action === 'paste') {
      root.delegationModel.doCtrlVKeyInjectAsync().catch(function () { S.error = '粘贴失败'; tell(S.error); });
    }
  };
  S.refresh = function () { if (S.ready) { scanHistory(); send('load'); } };
  S.dispose = function () {
    S.disposed = true;
    clearInterval(S.timer);
    if (S.ready) {
      setActive(false);
      rootNav().removeEventListener('click', onNav, true);
      document.removeEventListener('contextmenu', onContext, true);
      window.removeEventListener('error', onScriptError);
      window.removeEventListener('unhandledrejection', onScriptError);
      S.subs.forEach(function (s) { s.dispose(); });
      if (observer) observer.disconnect();
      nativeItems.forEach(function (item) { item.actions(ko.unwrap(item.actions).filter(function (action) { return action.id !== saveActionId; })); });
      var nav = root.navigationMenuViewModel;
      nav.navigationMenuItems.remove(navItem);
      var index = nav.customNavigationMenuClickHandlers.indexOf(navHandler);
      if (index >= 0) nav.customNavigationMenuClickHandlers.splice(index, 1);
      [view, document.getElementById('winvplus-style')].forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
    }
    delete window.__winvPlus;
  };
  function rootNav() { return document.getElementById('navigation-menu-container'); }
  function install() {
    if (S.disposed || !window.ko) return false;
    var nav = rootNav(), content = document.getElementById('expanded-view-content');
    if (!nav || !content) return false;
    root = ko.dataFor(nav);
    if (!root || !root.navigationMenuViewModel || !root.delegationModel || !root.appendCustomClickHandlerToNavigationMenuModel) return false;
    var clipboard = nav.querySelector('[id^="navigation-menu-item-container-clipboard"]');
    if (!clipboard) return false;

    var style = el('style'); style.id = 'winvplus-style';
    style.textContent = [
      '.winvplus-phrases-open #expanded-view-content-lists,.winvplus-phrases-open #expanded-view-scroll-space{display:none!important}',
      '#winvplus-view{box-sizing:border-box;color:inherit;overflow-y:auto;height:100%}',
      '#winvplus-view[hidden]{display:none!important}',
      '.winvplus-list{list-style:none;padding:0;margin:0 calc(14 * (1 / 16) * 1rem) calc(8 * (1 / 16) * 1rem)}',
      '.winvplus-status{font-size:calc(12px * var(--expanded-view-scale-ratio) * var(--debug-text-scale-factor));color:var(--foreground-secondary-rest-color)}',
      '.winvplus-paste{min-width:0;text-align:left;cursor:default}',
      '.winvplus-paste .clipboard-history-items-list-item-text{min-width:0}',
      '.winvplus-action-icon{font-family:"Segoe Fluent Icons","Segoe MDL2 Assets"}',
      '.winvplus-remove:focus,.winvplus-paste:focus{outline:none}',
      '.visible-focus .winvplus-remove:focus,.visible-focus .winvplus-paste:focus{outline:2px solid;outline-offset:-2px}',
      '.winvplus-empty{text-align:center;padding:40px 12px;line-height:1.6}',
      '.winvplus-empty-icon{font:26px "Segoe Fluent Icons","Segoe MDL2 Assets";margin-bottom:12px;opacity:.55}',
      '.winvplus-empty p{font-size:12px;opacity:.6;margin:8px 0}'
    ].join('\n');
    document.head.appendChild(style);

    var nativeItem = ko.dataFor(clipboard);
    navItem = new nativeItem.constructor({
      id: 'winvplus-phrases', displayLabel: '\uE734', accessibilityLabel: '常用语',
      displayLabelFontOverride: 'Segoe Fluent Icons'
    });
    navHandler = {
      appendCustomNavigationMenuItems: function (items) {
        var result = items.filter(function (item) { return item.id !== navItem.id; });
        var index = result.findIndex(function (item) { return item.id.indexOf('clipboard') === 0; });
        if (index >= 0) result.splice(index + 1, 0, navItem);
        return result;
      },
      onNavigationMenuItemClick: function (item) {
        if (item.id !== navItem.id) return false;
        setActive(true); return true;
      }
    };
    root.appendCustomClickHandlerToNavigationMenuModel(navHandler);
    var navModel = root.navigationMenuViewModel;
    var items = navHandler.appendCustomNavigationMenuItems(ko.unwrap(navModel.navigationMenuItems));
    navModel.updateNavigationMenuItemsVisibility(items, ko.unwrap(root.currentViewId));
    navModel.navigationMenuItems(items);

    view = el('section'); view.id = 'winvplus-view'; view.hidden = true;
    view.setAttribute('role', 'tabpanel'); view.setAttribute('aria-label', '常用语');
    var heading = el('div', 'category-header');
    var headerContent = el('div', 'category-header-container');
    headerContent.appendChild(el('span', 'category-header-text', '常用语'));
    status = el('span', 'winvplus-status'); headerContent.appendChild(status); heading.appendChild(headerContent);
    list = el('ul', 'clipboard-history-items-list winvplus-list'); view.appendChild(heading); view.appendChild(list); content.appendChild(view);
    nav.addEventListener('click', onNav, true);
    document.addEventListener('contextmenu', onContext, true);
    window.addEventListener('error', onScriptError);
    window.addEventListener('unhandledrejection', onScriptError);
    if (ko.isObservable(root.currentViewId)) S.subs.push(root.currentViewId.subscribe(function () { setActive(false); }));
    // Release the native list before Windows begins its close/navigation animations.
    if (ko.isObservable(root.isLastShowHideEventShow)) S.subs.push(root.isLastShowHideEventShow.subscribe(function (visible) { if (!visible) setActive(false); }));
    scanHistory();
    observer = new window.MutationObserver(scanHistory);
    observer.observe(document.getElementById('expanded-view-content-lists'), { childList: true, subtree: true });
    S.ready = true; send('load'); return true;
  }
  if (!install()) {
    var attempts = 0;
    S.timer = setInterval(function () { if (install() || ++attempts >= 50) clearInterval(S.timer); }, 200);
  }
})();
