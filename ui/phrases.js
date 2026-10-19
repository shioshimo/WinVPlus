(function () {
  'use strict';
  if (window.__winvPlus) { window.__winvPlus.refresh(); return; }

  var S = { phrases: [], active: false, ready: false, disposed: false, subs: [], outbox: [], error: '', menuClicks: 0 };
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
      menuClicks: S.menuClicks,
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
      empty.appendChild(el('p', '', '右键剪贴板记录，添加到这里'));
      list.appendChild(empty);
    }
    S.phrases.forEach(function (phrase) {
      var card = el('li', 'expanded-view-list-item clipboard-history-items-list-item winvplus-card');
      var paste = el('div', 'clipboard-history-items-list-item-content winvplus-paste');
      paste.tabIndex = 0;
      paste.setAttribute('role', 'button');
      paste.title = phrase.text || '图片';
      paste.setAttribute('aria-label', '粘贴：' + (phrase.text || '图片'));
      if (phrase.type === 'image') {
        var frame = el('div', 'clipboard-history-items-list-item-imageframe');
        var image = el('img', 'clipboard-history-items-list-item-image');
        image.src = phrase.preview; image.alt = '保存的图片';
        frame.appendChild(image); paste.appendChild(frame);
      } else paste.appendChild(el('span', 'clipboard-history-items-list-item-text', phrase.text));
      paste.addEventListener('click', function () { send('paste', { id: phrase.id }); });
      paste.addEventListener('keydown', function (e) {
        if (e.target === paste && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); paste.click(); }
      });
      var actions = el('ul', 'clipboard-history-items-list-item-actions-primary-view');
      var more = el('li', 'clipboard-history-items-list-item-action winvplus-more');
      more.tabIndex = 0; more.setAttribute('role', 'button');
      more.appendChild(el('span', 'clipboard-history-items-list-item-action-icon', '\uE712'));
      more.setAttribute('aria-label', '常用语操作');
      more.title = '操作';
      more.addEventListener('click', function (e) {
        e.stopPropagation();
        showMenu(e, [{ label: '移出常用语', run: function () { send('remove', { id: phrase.id }); } }]);
      });
      more.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); more.click(); }
      });
      card.addEventListener('contextmenu', function (e) {
        e.preventDefault(); e.stopPropagation();
        showMenu(e, [{ label: '移出常用语', run: function () { send('remove', { id: phrase.id }); } }]);
      });
      actions.appendChild(more); paste.appendChild(actions); card.appendChild(paste); list.appendChild(card);
    });
    tell(S.error || (S.phrases.length ? S.phrases.length + ' 条' : ''));
  }
  function hideMenu() { if (menu) menu.hidden = true; }
  function showMenu(event, actions) {
    while (menu.firstChild) menu.removeChild(menu.firstChild);
    actions.forEach(function (action) {
      var button = el('button', 'winvplus-menu-item', action.label);
      button.type = 'button'; button.setAttribute('role', 'menuitem');
      button.addEventListener('pointerenter', function () { button.classList.add('winvplus-hover'); });
      button.addEventListener('pointerleave', function () { button.classList.remove('winvplus-hover'); });
      button.addEventListener('click', function (e) { ++S.menuClicks; e.stopPropagation(); hideMenu(); action.run(); });
      menu.appendChild(button);
    });
    menu.hidden = false;
    var x = event.clientX, y = event.clientY;
    if (!x && !y && event.currentTarget && event.currentTarget.getBoundingClientRect) {
      var box = event.currentTarget.getBoundingClientRect(); x = box.left; y = box.bottom;
    }
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
    if (!event.clientX && !event.clientY) menu.firstChild.focus();
  }
  function onContext(e) {
    if (S.active) return;
    var card = e.target.closest && e.target.closest('li.expanded-view-list-item');
    if (!card || !card.querySelector('.clipboard-history-items-list-item-text,.clipboard-history-items-list-item-image')) return;
    var item = ko.dataFor(card);
    if (!item || !item.id) return;
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
      '#winvplus-view{box-sizing:border-box;color:inherit;overflow-y:auto;height:100%}',
      '#winvplus-view[hidden],#winvplus-menu[hidden]{display:none!important}',
      '.winvplus-list{list-style:none;padding:0;margin:0 calc(14 * (1 / 16) * 1rem) calc(8 * (1 / 16) * 1rem)}',
      '.winvplus-status{font-size:calc(12px * var(--expanded-view-scale-ratio) * var(--debug-text-scale-factor));color:var(--foreground-secondary-rest-color)}',
      '.winvplus-paste{min-width:0;text-align:left;cursor:default}',
      '.winvplus-paste .clipboard-history-items-list-item-text{min-width:0}',
      '.winvplus-more .clipboard-history-items-list-item-action-icon{font-family:"Segoe Fluent Icons","Segoe MDL2 Assets"}',
      '.winvplus-more:focus,.winvplus-paste:focus{outline:none}',
      '.visible-focus .winvplus-more:focus,.visible-focus .winvplus-paste:focus{outline:2px solid;outline-offset:-2px}',
      '.winvplus-empty{text-align:center;padding:40px 12px;line-height:1.6}',
      '.winvplus-empty-icon{font:26px "Segoe Fluent Icons","Segoe MDL2 Assets";margin-bottom:12px;opacity:.55}',
      '.winvplus-empty p{font-size:12px;opacity:.6;margin:8px 0}',
      '#winvplus-menu{position:fixed;z-index:2147483647;min-width:150px;padding:4px;border:1px solid var(--flyout-action-menu-border-color);border-radius:8px;background:var(--tooltip-background-color);color:var(--foreground-primary-rest-color);box-shadow:0 4px 16px rgba(0,0,0,.18)}',
      '.winvplus-menu-item{display:block;box-sizing:border-box;width:100%;border:0;border-radius:4px;padding:9px 12px;text-align:left;background:transparent;color:inherit;font-family:inherit;font-size:calc(14px * var(--expanded-view-scale-ratio) * var(--debug-text-scale-factor));line-height:calc(20px * var(--expanded-view-scale-ratio) * var(--debug-text-scale-factor));cursor:default}',
      '.winvplus-menu-item:hover,.winvplus-menu-item.winvplus-hover{background-color:var(--transparent-button-hover)}',
      '.winvplus-menu-item:active{background-color:var(--transparent-button-pressed)}',
      '.winvplus-menu-item:focus{outline:none}',
      '.visible-focus .winvplus-menu-item:focus{outline:2px solid;outline-offset:-2px}',
      '@media screen and (-ms-high-contrast:active){#winvplus-menu{background:Window;color:WindowText;border:1px solid WindowText}.winvplus-menu-item:hover{background:Highlight;color:HighlightText}}'
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
