(function () {
  'use strict';
  if (window.__winvPlus) { window.__winvPlus.refresh(); return; }

  var S = { phrases: [], active: false, ready: false, disposed: false, subs: [], outbox: [], error: '' };
  window.__winvPlus = S;
  var root, navItem, navHandler, view, list, status, menu, selectedBefore = [];

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
    hideMenu();
  }
  function render() {
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!S.phrases.length) {
      var empty = el('div', 'winvplus-empty');
      empty.appendChild(el('div', 'winvplus-empty-icon', '\uE734'));
      empty.appendChild(el('p', '', '右键剪贴板文字，添加到这里'));
      list.appendChild(empty);
    }
    S.phrases.forEach(function (phrase) {
      var card = el('div', 'winvplus-card');
      var paste = el('button', 'winvplus-paste', phrase.text);
      paste.type = 'button';
      paste.title = phrase.text;
      paste.setAttribute('aria-label', '粘贴：' + phrase.text);
      paste.addEventListener('click', function () { send('paste', { id: phrase.id }); });
      var more = el('button', 'winvplus-more', '\uE712');
      more.type = 'button';
      more.setAttribute('aria-label', '常用语操作');
      more.title = '操作';
      more.addEventListener('click', function (e) {
        e.stopPropagation();
        showMenu(e, [{ label: '移出常用语', run: function () { send('remove', { id: phrase.id }); } }]);
      });
      card.addEventListener('contextmenu', function (e) {
        e.preventDefault(); e.stopPropagation();
        showMenu(e, [{ label: '移出常用语', run: function () { send('remove', { id: phrase.id }); } }]);
      });
      card.appendChild(paste); card.appendChild(more); list.appendChild(card);
    });
    tell(S.error || (S.phrases.length ? S.phrases.length + ' 条' : ''));
  }
  function hideMenu() { if (menu) menu.hidden = true; }
  function showMenu(event, actions) {
    while (menu.firstChild) menu.removeChild(menu.firstChild);
    actions.forEach(function (action) {
      var button = el('button', 'winvplus-menu-item', action.label);
      button.type = 'button'; button.setAttribute('role', 'menuitem');
      button.addEventListener('click', function (e) { e.stopPropagation(); hideMenu(); action.run(); });
      menu.appendChild(button);
    });
    menu.hidden = false;
    var x = event.clientX, y = event.clientY;
    if (!x && !y && event.currentTarget && event.currentTarget.getBoundingClientRect) {
      var box = event.currentTarget.getBoundingClientRect(); x = box.left; y = box.bottom;
    }
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
    menu.firstChild.focus();
  }
  function onContext(e) {
    if (S.active) return;
    var card = e.target.closest && e.target.closest('li.expanded-view-list-item');
    if (!card || !card.querySelector('.clipboard-history-items-list-item-text')) return;
    var item = ko.dataFor(card);
    if (!item || !item.id || !item.isClipboardItem && !item.textLabelForTextContent) return;
    e.preventDefault(); e.stopPropagation();
    showMenu(e, [{ label: '添加到常用语', run: function () { send('add', { id: item.id }); } }]);
  }
  function onNav(e) {
    var tab = document.getElementById(navItem.containerHtmlId);
    if (!tab || !tab.contains(e.target)) setActive(false);
  }
  function onOutside(e) { if (!menu.contains(e.target)) hideMenu(); }
  function onKey(e) {
    if (e.key === 'Escape' && menu && !menu.hidden) { hideMenu(); e.stopPropagation(); }
  }
  S.receive = function (message) {
    if (message.error) { S.error = message.error; tell(message.error); return; }
    if (message.action !== 'load') S.error = '';
    if (message.phrases) { S.phrases = message.phrases; render(); }
    if (message.action === 'paste') {
      root.delegationModel.doCtrlVKeyInjectAsync().catch(function () { S.error = '粘贴失败'; tell(S.error); });
    }
  };
  S.refresh = function () { if (S.ready) { hideMenu(); send('load'); } };
  S.dispose = function () {
    S.disposed = true;
    clearInterval(S.timer);
    if (S.ready) {
      setActive(false);
      rootNav().removeEventListener('click', onNav, true);
      document.removeEventListener('contextmenu', onContext, true);
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      S.subs.forEach(function (s) { s.dispose(); });
      var nav = root.navigationMenuViewModel;
      nav.navigationMenuItems.remove(navItem);
      var index = nav.customNavigationMenuClickHandlers.indexOf(navHandler);
      if (index >= 0) nav.customNavigationMenuClickHandlers.splice(index, 1);
      [view, menu, document.getElementById('winvplus-style')].forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
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
      '.winvplus-tab{position:relative;cursor:pointer;font-family:"Segoe Fluent Icons","Segoe MDL2 Assets"}',
      '.winvplus-tab:focus-visible{outline:2px solid Highlight;outline-offset:-3px;border-radius:4px}',
      '#winvplus-view{padding:0 12px 12px;box-sizing:border-box;color:inherit}',
      '#winvplus-view[hidden],#winvplus-menu[hidden]{display:none!important}',
      '.winvplus-heading{display:flex;align-items:center;justify-content:space-between;min-height:42px;gap:8px}',
      '.winvplus-heading h2{font:inherit;font-size:14px;margin:0;font-weight:600}',
      '.winvplus-status{font-size:11px;opacity:.68}',
      '.winvplus-card{position:relative;display:flex;margin:0 0 8px;border:1px solid rgba(127,127,127,.18);border-radius:8px;background:rgba(255,255,255,.55);box-shadow:0 1px 2px rgba(0,0,0,.06)}',
      '.winvplus-paste{flex:1;min-width:0;border:0;border-radius:8px;padding:12px 34px 12px 12px;text-align:start;white-space:pre-wrap;word-break:break-word;max-height:132px;overflow:hidden;font:inherit;line-height:1.45;color:inherit;background:transparent;cursor:pointer}',
      '.winvplus-card:hover{background:rgba(127,127,127,.1)}',
      '.winvplus-paste:focus-visible,.winvplus-more:focus-visible{outline:2px solid Highlight;outline-offset:-2px}',
      '.winvplus-more{position:absolute;right:5px;top:6px;width:28px;height:28px;border:0;border-radius:4px;font-family:"Segoe Fluent Icons","Segoe MDL2 Assets";color:inherit;background:transparent;cursor:pointer}',
      '.winvplus-more:hover{background:rgba(127,127,127,.15)}',
      '.winvplus-empty{text-align:center;padding:40px 12px;line-height:1.6}',
      '.winvplus-empty-icon{font:26px "Segoe Fluent Icons","Segoe MDL2 Assets";margin-bottom:12px;opacity:.55}',
      '.winvplus-empty p{font-size:12px;opacity:.6;margin:8px 0}',
      '#winvplus-menu{position:fixed;z-index:2147483647;min-width:150px;padding:4px;border:1px solid rgba(127,127,127,.25);border-radius:8px;background:#fafafa;color:#202020;box-shadow:0 4px 16px rgba(0,0,0,.18)}',
      '.winvplus-menu-item{display:block;width:100%;border:0;border-radius:4px;padding:9px 12px;text-align:start;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
      '.winvplus-menu-item:hover,.winvplus-menu-item:focus{background:rgba(127,127,127,.15);outline:none}',
      '@media(prefers-color-scheme:dark){.winvplus-card{background:rgba(255,255,255,.05)}#winvplus-menu{background:#292929;color:#fff}}',
      '@media(forced-colors:active){.winvplus-card,#winvplus-menu{background:Canvas;color:CanvasText;border:1px solid CanvasText}.winvplus-paste,.winvplus-more{color:ButtonText}}'
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
    var heading = el('div', 'winvplus-heading'); heading.appendChild(el('h2', '', '常用语'));
    status = el('span', 'winvplus-status'); heading.appendChild(status);
    list = el('div', 'winvplus-list'); view.appendChild(heading); view.appendChild(list); content.appendChild(view);
    menu = el('div'); menu.id = 'winvplus-menu'; menu.hidden = true; menu.setAttribute('role', 'menu'); document.body.appendChild(menu);
    nav.addEventListener('click', onNav, true);
    document.addEventListener('contextmenu', onContext, true);
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    if (ko.isObservable(root.currentViewId)) S.subs.push(root.currentViewId.subscribe(function () { setActive(false); }));
    if (ko.isObservable(root.isLastShowHideEventShow)) S.subs.push(root.isLastShowHideEventShow.subscribe(function (visible) { if (!visible) hideMenu(); }));
    S.ready = true; send('load'); return true;
  }
  if (!install()) {
    var attempts = 0;
    S.timer = setInterval(function () { if (install() || ++attempts >= 50) clearInterval(S.timer); }, 200);
  }
})();
