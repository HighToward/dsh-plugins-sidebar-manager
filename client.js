/**
 * dsh-plugins-sidebar-manager / client half
 *
 * The shell renders the left-top panel list itself: every plugin that wants a
 * row registers into `sidebar.panellist`, and the shell sorts those rows by the
 * `order` each plugin chose and draws them in one flat column. There is no seat
 * for a group title and no way for one plugin to touch another's row, so the
 * only place a grouping can live is the rendered DOM.
 *
 * This plugin therefore decorates that column after the fact:
 *
 *   - it finds the panel list by the labels the shell stamped on the rows,
 *   - it leaves every React-owned button where React put it,
 *   - it orders the column through CSS `order` (the column is a flex container,
 *     so visual order and DOM order are independent) and hides rows with
 *     `display: none`,
 *   - it inserts its own group titles as siblings, which React never touches
 *     because they were never part of its element tree.
 *
 * Ordering through CSS instead of moving nodes is the load-bearing decision:
 * React re-inserts its children by fiber position on every render, so a moved
 * node gets snapped back on the next locale change or panel switch, while an
 * `order` value survives because React does not manage the `style` attribute on
 * those buttons.
 *
 * The configuration is a document, not a side effect: localStorage carries it
 * so the first paint is already organized, and the host half persists the same
 * document under `$DSH_HOME` so it survives a browser cache wipe. Writing the
 * sidebar never throws — the web shell fails its whole boot when a plugin's
 * apply throws, and an organizer must not take the GUI down.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugins-sidebar-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    /** Settings section id (also the id of its nav icon). */
    const SECTION_ID = 'plugins-sidebar-manager';
    /** Settings nav position: General 0, Models 10, Plugins 15, market 40. */
    const SECTION_ORDER = 16;
    /** Route prefix served by the host half. */
    const API = '/api/dsh-plugins-sidebar-manager';
    /** localStorage key of the browser mirror. */
    const STORAGE_KEY = 'dsh.plugins-sidebar-manager.v1';
    /** CSS tag id, so a reload replaces the sheet instead of stacking one. */
    const CSS_TAG = '@local/dsh-plugins-sidebar-manager/sidebar-manager.css';

    // ───────────────────────────── text ─────────────────────────────

    const MESSAGES = {
      zh: {
        nav: '插件侧栏管理',
        title: '插件侧栏管理',
        intro:
          '插件都往左上角这一列里塞入口，塞多了就分不清。这里可以给它们建一套分类，一级分类下面还能再挂二级，也可以把用不上的入口收起来。改完立刻生效，不用重启。',
        'toolbar.enable': '接管侧栏',
        'toolbar.enableHint': '关掉后侧栏回到各插件注册时的原样，配置不会丢。',
        'toolbar.rescan': '重新扫描',
        'toolbar.reset': '恢复默认',
        'toolbar.resetConfirm': '再点一次确认',
        detected: '检测到 {count} 个侧栏入口',
        'groups.title': '分类',
        'groups.empty': '还没有分类。先建一个一级分类，再把入口放进去。',
        'groups.add': '新建一级分类',
        'groups.addChild': '新建二级分类',
        'groups.name': '分类名称',
        'groups.namePlaceholder': '比如：创作、工具、调试',
        'groups.level1': '一级',
        'groups.level2': '二级',
        'groups.parent': '上级分类',
        'groups.parentNone': '未指定',
        'groups.remove': '删除',
        'groups.up': '上移',
        'groups.down': '下移',
        'groups.collapse': '折叠',
        'groups.expand': '展开',
        'groups.itemsEmpty': '这个分类里还没有入口。',
        'groups.pick': '选择入口',
        'groups.addItem': '加入',
        'items.remove': '移出分类',
        'ungrouped.title': '未分类',
        'ungrouped.hint': '没归类的入口会排在所有分类后面，顺序跟插件注册时一致。',
        'ungrouped.empty': '没有未分类的入口。',
        'item.hide': '隐藏',
        'item.show': '显示',
        'item.hiddenBadge': '已隐藏',
        'empty.detected': '暂时没检测到侧栏入口。等插件加载完再点「重新扫描」。',
        'note.storage': '配置同时存在本机与 $DSH_HOME，清浏览器缓存也不会丢。',
      },
      en: {
        nav: 'Plugin Sidebar',
        title: 'Plugin Sidebar',
        intro:
          'Every plugin adds its row to the same column in the top-left corner. Group those rows here, nest a second level where it helps, and hide what you never open. Changes apply immediately.',
        'toolbar.enable': 'Manage the sidebar',
        'toolbar.enableHint': 'Turn it off to restore the plugin-registered order. Your setup is kept.',
        'toolbar.rescan': 'Rescan',
        'toolbar.reset': 'Reset',
        'toolbar.resetConfirm': 'Click again to confirm',
        detected: '{count} sidebar entries found',
        'groups.title': 'Groups',
        'groups.empty': 'No groups yet. Create one, then move entries into it.',
        'groups.add': 'New group',
        'groups.addChild': 'New subgroup',
        'groups.name': 'Group name',
        'groups.namePlaceholder': 'e.g. Writing, Tools, Debug',
        'groups.level1': 'Top level',
        'groups.level2': 'Nested',
        'groups.parent': 'Parent group',
        'groups.parentNone': 'None',
        'groups.remove': 'Delete',
        'groups.up': 'Move up',
        'groups.down': 'Move down',
        'groups.collapse': 'Collapse',
        'groups.expand': 'Expand',
        'groups.itemsEmpty': 'No entries in this group yet.',
        'groups.pick': 'Pick an entry',
        'groups.addItem': 'Add',
        'items.remove': 'Take out',
        'ungrouped.title': 'Ungrouped',
        'ungrouped.hint': 'Entries without a group trail the groups in plugin order.',
        'ungrouped.empty': 'Every entry is grouped.',
        'item.hide': 'Hide',
        'item.show': 'Show',
        'item.hiddenBadge': 'Hidden',
        'empty.detected': 'No sidebar entries yet. Rescan once the plugins finish loading.',
        'note.storage': 'The document is stored locally and under $DSH_HOME, so clearing a browser cache keeps it.',
      },
    };

    /** Official primitives, when the host serves them. */
    let primitives = {};
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') ?? {};
    } catch {
      primitives = {};
    }

    /**
     * Active language, narrowed to a language this plugin has a dictionary for.
     * @param ctx - the client context.
     * @returns the two-letter language code.
     */
    function activeLanguage(ctx) {
      try {
        const locale = ctx.get('locale');
        const active = locale?.getSnapshot?.()?.active;
        if (typeof active === 'string') {
          const short = active.slice(0, 2).toLowerCase();
          if (MESSAGES[short] !== undefined) return short;
        }
      } catch {
        /* fall through */
      }
      return 'zh';
    }

    /**
     * Translate one key out of the local dictionary.
     * @param ctx - the client context.
     * @param key - the message key.
     * @param params - `{name}` placeholders.
     * @returns the resolved text.
     */
    function translate(ctx, key, params) {
      const language = activeLanguage(ctx);
      const dictionary = MESSAGES[language] ?? MESSAGES.zh;
      const template = dictionary[key] ?? MESSAGES.zh[key] ?? key;
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        name in params ? String(params[name]) : match,
      );
    }

    /**
     * Render a slot label, which may be a thunk the shell re-reads on every
     * locale change.
     * @param value - the label or a function returning it.
     * @returns the resolved text, if any.
     */
    function resolveLabel(value) {
      if (typeof value === 'function') {
        try {
          const resolved = value();
          return typeof resolved === 'string' ? resolved : undefined;
        } catch {
          return undefined;
        }
      }
      return typeof value === 'string' ? value : undefined;
    }

    // ─────────────────────────── configuration ───────────────────────────

    /** A fresh, do-nothing document. */
    function emptyConfig() {
      return { version: 1, enabled: true, groups: [], items: {} };
    }

    /**
     * Coerce whatever was in storage into the shape this plugin reads. A
     * half-written or older document must never crash the sidebar, so every
     * field is validated and dropped instead of trusted.
     * @param raw - the parsed document, if any.
     * @returns a usable document.
     */
    function normalizeConfig(raw) {
      const config = emptyConfig();
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return config;
      if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled;
      const groups = [];
      const seen = new Set();
      if (Array.isArray(raw.groups)) {
        for (const candidate of raw.groups) {
          if (candidate === null || typeof candidate !== 'object') continue;
          const id = typeof candidate.id === 'string' && candidate.id !== '' ? candidate.id : undefined;
          if (id === undefined || seen.has(id)) continue;
          seen.add(id);
          groups.push({
            id,
            name: typeof candidate.name === 'string' ? candidate.name : '',
            level: candidate.level === 2 ? 2 : 1,
            parent: typeof candidate.parent === 'string' ? candidate.parent : '',
            collapsed: candidate.collapsed === true,
          });
        }
      }
      // A second-level group whose parent vanished is promoted instead of
      // dropped: losing a group would silently scatter its entries.
      for (const group of groups) {
        if (group.level !== 2) {
          group.parent = '';
          continue;
        }
        const parent = groups.find(
          (other) => other.id === group.parent && other.level === 1 && other.id !== group.id,
        );
        if (parent === undefined) {
          group.level = 1;
          group.parent = '';
        }
      }
      config.groups = groups;
      const items = {};
      if (raw.items !== null && typeof raw.items === 'object' && !Array.isArray(raw.items)) {
        for (const [key, value] of Object.entries(raw.items)) {
          if (key === '' || value === null || typeof value !== 'object') continue;
          const groupId = typeof value.group === 'string' ? value.group : '';
          items[key] = {
            group: seen.has(groupId) ? groupId : '',
            order: Number.isFinite(value.order) ? Number(value.order) : 0,
            hidden: value.hidden === true,
          };
        }
      }
      config.items = items;
      return config;
    }

    /**
     * Read the browser mirror.
     * @returns the normalized document.
     */
    function readStoredConfig() {
      try {
        const text = window.localStorage.getItem(STORAGE_KEY);
        if (text === null) return emptyConfig();
        return normalizeConfig(JSON.parse(text));
      } catch {
        return emptyConfig();
      }
    }

    /**
     * Write the browser mirror. A quota error must not break the interaction.
     * @param config - the document to keep.
     */
    function writeStoredConfig(config) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      } catch {
        /* storage disabled: the host copy still carries the document */
      }
    }

    /**
     * Build the small external store the sidebar enhancer and the settings page
     * share. The snapshot reference only changes when the document changes, so
     * `useSyncExternalStore` can compare it directly.
     * @returns the store.
     */
    function createConfigStore() {
      let snapshot = readStoredConfig();
      const listeners = new Set();
      let mirror = 0;
      const notify = () => {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch (error) {
            console.error('[plugins-sidebar-manager] listener failed', error);
          }
        }
      };
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        commit: (next) => {
          snapshot = normalizeConfig(next);
          writeStoredConfig(snapshot);
          notify();
          window.clearTimeout(mirror);
          mirror = window.setTimeout(() => {
            void fetch(`${API}/config`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ document: snapshot }),
              cache: 'no-store',
              credentials: 'same-origin',
            }).catch(() => {
              /* the browser mirror still holds the document */
            });
          }, 400);
        },
        replace: (next) => {
          snapshot = normalizeConfig(next);
          writeStoredConfig(snapshot);
          notify();
        },
      };
    }

    const STORE = createConfigStore();

    // ─────────────────────────── sidebar enhancer ───────────────────────────

    /** Write an inline property only when it actually changes. */
    function setInline(element, property, value) {
      if (element.style.getPropertyValue(property) !== value) {
        element.style.setProperty(property, value);
      }
    }

    /**
     * Write an attribute only when it actually changes. A `MutationObserver`
     * cannot tell a real edit from a rewrite of the same value, so an
     * unconditional `setAttribute` on an element the observer watches would
     * schedule another pass forever.
     * @param element - the element to touch.
     * @param name - the attribute name.
     * @param value - the attribute value.
     */
    function setAttr(element, name, value) {
      if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    }

    /**
     * Test one CSS-module class on an element, tolerating the build's hash
     * prefix. The shell compiles its styles as CSS modules, so `panelRow` ships
     * as `wtg9ga_panelRow`: the local name survives, the prefix does not stay
     * put across releases. Matching the suffix of one class token keeps the
     * check honest without pinning a hash that changes on every build.
     * @param element - the element to inspect.
     * @param name - the CSS-module local name, such as `panelRow`.
     * @returns whether the element carries that class.
     */
    function hasCssClass(element, name) {
      const value = element.className;
      // SVG elements expose `className` as an object, not a string.
      const text = typeof value === 'string' ? value : (value?.baseVal ?? '');
      if (typeof text !== 'string' || text === '') return false;
      const suffix = `_${name}`;
      for (const token of text.split(/\s+/)) {
        if (token === name || token.endsWith(suffix)) return true;
      }
      return false;
    }

    /**
     * Read the panels the shell knows about. Labels resolve through the same
     * thunk the shell used, so the text matches the row's `aria-label`.
     * @param ctx - the client context.
     * @returns the panel catalog, sorted the way the shell sorts it.
     */
    function readPanels(ctx) {
      let entries = [];
      try {
        entries = ctx.slots?.entriesOfSlot?.('sidebar.panellist') ?? [];
      } catch {
        entries = [];
      }
      const panels = [];
      for (const entry of entries) {
        const options = entry?.options ?? {};
        if (typeof options.id !== 'string' || options.id === '') continue;
        panels.push({
          id: options.id,
          label: resolveLabel(options.label) ?? options.id,
          order: Number.isFinite(options.order) ? Number(options.order) : 0,
        });
      }
      panels.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return panels;
    }

    /**
     * Find the shell's panel column. Identification is by content, not by class
     * name: CSS-module hashes change between releases, but the rows carry the
     * labels the slot registry itself reports, and that registry is the same one
     * the shell read when it drew them. Guessing wider than this would risk
     * reorganizing some other nav in the page.
     * @param panels - the panel catalog.
     * @returns the nav element, if it is on screen.
     */
    function findPanelList(panels) {
      if (panels.length === 0) return null;
      const labels = new Set(panels.map((panel) => panel.label));
      let best = null;
      let bestScore = 0;
      for (const nav of document.querySelectorAll('nav')) {
        let score = 0;
        for (const child of nav.children) {
          if (child.hasAttribute('data-cem-group')) continue;
          const button = rowButtonOf(child);
          if (button === null) continue;
          if (button.getAttribute('aria-haspopup') === 'menu') continue;
          if (labels.has(button.getAttribute('aria-label') ?? '')) score += 1;
        }
        if (score > bestScore) {
          best = nav;
          bestScore = score;
        }
      }
      return best;
    }

    /**
     * Find the interactive row inside one direct child of the column.
     *
     * Two shapes exist across releases. Up to 0.2.1 the shell handed the
     * `Tooltip` a bare button, so the child *was* the button. From 0.2.2 the
     * shell wraps the button in `div.panelEntry` and adds a second button
     * beside it that unpins the entry, so a wrapper can hold more than one.
     * The row is therefore the button that carries an `aria-label` and is not
     * the unpin control, which is identified by its own class rather than by
     * position or text.
     * @param slot - a direct child of the panel column.
     * @returns the row button, if this child is a panel row.
     */
    function rowButtonOf(slot) {
      if (slot.tagName === 'BUTTON') return slot;
      const buttons = Array.from(slot.querySelectorAll?.('button') ?? []);
      const candidates = buttons.filter((button) => !hasCssClass(button, 'panelUnpin'));
      for (const button of candidates) {
        if (hasCssClass(button, 'panelRow')) return button;
      }
      for (const button of candidates) {
        if (button.getAttribute('aria-label') !== null) return button;
      }
      return null;
    }

    /**
     * The panel rows React currently owns, in DOM order. A row is recognised by
     * its label: the same label the slot registry reported for that entry.
     * Matching labels in registration order disambiguates two panels that
     * happen to share a name.
     * @param nav - the panel column.
     * @param panels - the panel catalog.
     * @returns one record per row.
     */
    function collectRows(nav, panels) {
      const buckets = new Map();
      for (const panel of panels) {
        const bucket = buckets.get(panel.label);
        if (bucket === undefined) buckets.set(panel.label, [panel]);
        else bucket.push(panel);
      }
      const rows = [];
      let index = 0;
      for (const slot of Array.from(nav.children)) {
        if (slot.hasAttribute('data-cem-group')) continue;
        const button = rowButtonOf(slot);
        if (button === null) continue;
        if (button.getAttribute('aria-haspopup') === 'menu') continue;
        const label = button.getAttribute('aria-label') ?? '';
        const bucket = buckets.get(label);
        const panel = bucket !== undefined && bucket.length > 0 ? bucket.shift() : undefined;
        rows.push({
          element: slot,
          panelId: panel?.id,
          nativeIndex: index,
        });
        index += 1;
      }
      return rows;
    }

    /**
     * Turn the document plus the live rows into one ordered list of sidebar
     * children. Hidden entries stay in the list so that un-hiding one drops it
     * back where it belongs instead of at the bottom.
     * @param config - the document.
     * @param rows - the live panel rows.
     * @returns the plan.
     */
    function buildPlan(config, rows) {
      const itemOf = (id) => config.items[id];
      const groups = config.groups;
      const groupById = new Map(groups.map((group) => [group.id, group]));
      const owningGroup = (row) => {
        if (row.panelId === undefined) return '';
        const item = itemOf(row.panelId);
        if (item === undefined) return '';
        return groupById.has(item.group) ? item.group : '';
      };
      const rowsOf = (groupId) =>
        rows
          .filter((row) => owningGroup(row) === groupId)
          .sort(
            (a, b) =>
              (itemOf(a.panelId)?.order ?? 0) - (itemOf(b.panelId)?.order ?? 0) ||
              a.nativeIndex - b.nativeIndex,
          );

      const plan = [];
      const placed = new Set();
      const keyOf = (row) => row.panelId ?? `#${row.nativeIndex}`;

      const pushRow = (row, visible) => {
        plan.push({ kind: 'row', row, visible });
        placed.add(keyOf(row));
      };

      const pushGroup = (group) => {
        const members = rowsOf(group.id);
        const subs =
          group.level === 1
            ? groups.filter((candidate) => candidate.level === 2 && candidate.parent === group.id)
            : [];
        plan.push({ kind: 'group', group, visible: members.length > 0 || subs.length > 0 || group.level === 1 });
        if (group.collapsed) {
          for (const row of members) pushRow(row, false);
          for (const sub of subs) {
            for (const row of rowsOf(sub.id)) pushRow(row, false);
            plan.push({ kind: 'group', group: sub, visible: false });
          }
          return;
        }
        for (const row of members) pushRow(row, itemOf(row.panelId)?.hidden !== true);
        for (const sub of subs) pushGroup(sub);
      };

      for (const group of groups.filter((candidate) => candidate.level === 1)) pushGroup(group);

      for (const row of rows) {
        if (placed.has(keyOf(row))) continue;
        if (row.panelId === undefined) {
          pushRow(row, true);
          continue;
        }
        const item = itemOf(row.panelId);
        pushRow(row, item?.hidden !== true);
      }
      return plan;
    }

    /**
     * Start decorating the panel column.
     * @param ctx - the client context.
     * @param store - the configuration store.
     * @returns a disposer.
     */
    function startEnhancer(ctx, store) {
      /** Group title elements, keyed by group id. */
      const headers = new Map();
      let nav = null;
      let scheduled = false;
      let frame = 0;

      const clearHeaders = () => {
        for (const header of headers.values()) header.element.remove();
        headers.clear();
      };

      const resetNav = (target) => {
        if (target === null) return;
        target.removeAttribute('data-cem-managed');
        target.removeAttribute('data-cem-rail');
        for (const child of target.children) {
          if (child.hasAttribute('data-cem-group')) continue;
          setInline(child, 'order', '');
          setInline(child, 'display', '');
        }
        clearHeaders();
      };

      /**
       * Build one group title. The markup is assembled node by node rather
       * than as an HTML string: the title is user text, and the caret is a
       * fixed glyph, so there is nothing here worth handing to a parser.
       * @param group - the group to draw.
       * @returns the title's parts.
       */
      const createHeader = (group) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'cem-group';
        element.dataset.cemGroup = group.id;

        const caret = document.createElement('span');
        caret.className = 'cem-caret';
        caret.setAttribute('aria-hidden', 'true');
        caret.innerHTML =
          '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

        const label = document.createElement('span');
        label.className = 'cem-group-label';

        element.appendChild(caret);
        element.appendChild(label);
        element.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const current = store.getSnapshot();
          const id = element.dataset.cemGroup;
          if (!current.groups.some((candidate) => candidate.id === id)) return;
          store.commit({
            ...current,
            groups: current.groups.map((candidate) =>
              candidate.id === id ? { ...candidate, collapsed: !candidate.collapsed } : candidate,
            ),
          });
        });
        return { element, label };
      };

      /** Create or refresh one group title. */
      const ensureHeader = (group) => {
        let header = headers.get(group.id);
        if (header !== undefined && !header.element.isConnected) {
          headers.delete(group.id);
          header = undefined;
        }
        if (header === undefined) {
          header = createHeader(group);
          nav.appendChild(header.element);
          headers.set(group.id, header);
        }
        if (header.label.textContent !== group.name) header.label.textContent = group.name;
        header.element.dataset.cemLevel = String(group.level);
        setAttr(header.element, 'aria-expanded', group.collapsed ? 'false' : 'true');
        setAttr(header.element, 'aria-label', group.name);
        return header;
      };

      const apply = () => {
        if (nav !== null && !nav.isConnected) {
          headers.clear();
          nav = null;
        }
        const config = store.getSnapshot();
        const panels = readPanels(ctx);
        const found = findPanelList(panels);
        if (found === null) {
          if (nav !== null) resetNav(nav);
          nav = null;
          return;
        }
        if (nav !== found) {
          if (nav !== null) resetNav(nav);
          nav = found;
        }
        if (!config.enabled) {
          resetNav(nav);
          return;
        }
        nav.setAttribute('data-cem-managed', '1');

        const rows = collectRows(nav, panels);
        const plan = buildPlan(config, rows);

        // The menu button ends the column. It is React's last child, so it gets
        // an order past every planned element to keep it there.
        const more = Array.from(nav.children).find(
          (child) => rowButtonOf(child)?.getAttribute('aria-haspopup') === 'menu',
        );

        // Rail mode: the column collapses to a 36px strip of icons, where a
        // title has nowhere to sit. Measuring the rows themselves rather than
        // the column keeps this honest when the column is hidden entirely.
        const rail =
          rows.length > 0 &&
          rows.every((row) => {
            const rect = row.element.getBoundingClientRect();
            return rect.width > 0 && rect.width <= 40;
          });
        setAttr(nav, 'data-cem-rail', rail ? '1' : '0');

        const live = new Set();
        let index = 0;
        for (const step of plan) {
          const order = String((index + 1) * 10);
          if (step.kind === 'group') {
            const header = ensureHeader(step.group);
            setInline(header.element, 'order', order);
            setInline(header.element, 'display', step.visible && !rail ? '' : 'none');
            live.add(header.element);
          } else {
            setInline(step.row.element, 'order', order);
            setInline(step.row.element, 'display', step.visible ? '' : 'none');
            live.add(step.row.element);
          }
          index += 1;
        }
        for (const [id, header] of headers) {
          if (!live.has(header.element)) {
            header.element.remove();
            headers.delete(id);
          }
        }
        if (more !== undefined) setInline(more, 'order', String((index + 1) * 10));
      };

      const run = () => {
        try {
          apply();
        } catch (error) {
          console.error('[plugins-sidebar-manager] sidebar pass failed', error);
        }
      };

      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        frame = window.requestAnimationFrame(() => {
          scheduled = false;
          run();
        });
      };

      const observer = new MutationObserver(schedule);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-label', 'aria-current'],
      });

      const unsubscribe = store.subscribe(run);

      // The shell may mount the sidebar long after this plugin applies, and a
      // render that only swaps a label triggers no childList change worth
      // observing; a slow re-check covers both without costing anything.
      schedule();
      const timer = window.setInterval(schedule, 3000);

      return () => {
        observer.disconnect();
        unsubscribe();
        window.clearInterval(timer);
        window.cancelAnimationFrame(frame);
        if (nav !== null) resetNav(nav);
        nav = null;
      };
    }

    // ─────────────────────────── document edits ───────────────────────────

    /** Next free group id. */
    function nextGroupId(config) {
      const taken = new Set(config.groups.map((group) => group.id));
      let index = config.groups.length + 1;
      while (taken.has(`g${index}`)) index += 1;
      return `g${index}`;
    }

    /** Next free order inside one group. */
    function nextItemOrder(config, groupId) {
      let max = -1;
      for (const item of Object.values(config.items)) {
        if (item.group === groupId && Number.isFinite(item.order)) max = Math.max(max, item.order);
      }
      return max + 1;
    }

    /** Swap two top-level groups. */
    function moveGroup(config, id, delta) {
      const groups = [...config.groups];
      const plain = groups.filter((group) => group.level === 1);
      const position = plain.findIndex((group) => group.id === id);
      const target = position + delta;
      if (position < 0 || target < 0 || target >= plain.length) return config;
      const a = groups.findIndex((group) => group.id === id);
      const b = groups.findIndex((group) => group.id === plain[target].id);
      [groups[a], groups[b]] = [groups[b], groups[a]];
      return { ...config, groups };
    }

    /** Move one entry inside its group. */
    function moveItem(config, panelId, delta) {
      const item = config.items[panelId];
      if (item === undefined || item.group === '') return config;
      const siblings = Object.entries(config.items)
        .filter(([, value]) => value.group === item.group)
        .sort((a, b) => a[1].order - b[1].order);
      const position = siblings.findIndex(([id]) => id === panelId);
      const target = position + delta;
      if (position < 0 || target < 0 || target >= siblings.length) return config;
      const swapped = [...siblings];
      const [moved] = swapped.splice(position, 1);
      swapped.splice(target, 0, moved);
      const items = { ...config.items };
      swapped.forEach(([id], index) => {
        items[id] = { ...items[id], order: index };
      });
      return { ...config, items };
    }

    // ─────────────────────────── settings UI ───────────────────────────

    /** Local switch, used when the primitives package is unavailable. */
    function LocalSwitch({ checked, disabled, label, onChange }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          className: `cem-switch${checked ? ' cem-switch-on' : ''}`,
          disabled: disabled === true,
          onClick: () => onChange(!checked),
        },
        h('span', { className: 'cem-switch-knob' }),
      );
    }

    const UISwitch = typeof primitives.Switch === 'function' ? primitives.Switch : LocalSwitch;

    /** Subscribe to a store through the React 18+ external-store hook. */
    function useStoreSnapshot(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
    }

    /** Panel catalog that re-reads whenever a plugin registers or a locale flips. */
    function usePanels(ctx) {
      const [revision, setRevision] = useState(0);
      useEffect(() => {
        const disposers = [];
        const bump = () => setRevision((value) => value + 1);
        try {
          const off = ctx.slots.subscribe('sidebar.panellist', bump);
          if (typeof off === 'function') disposers.push(off);
        } catch {
          /* slot not declared yet; the settings page still renders */
        }
        const locale = ctx.get('locale');
        if (locale !== undefined && typeof locale.subscribe === 'function') {
          const off = locale.subscribe(bump);
          if (typeof off === 'function') disposers.push(off);
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* ignore */
            }
          }
        };
      }, [ctx]);
      return useMemo(() => readPanels(ctx), [ctx, revision]);
    }

    /** Three staggered bars: a column, reordered. */
    function LogoMark({ size = 16 }) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 2.2, y: 3.1, width: 6.4, height: 2, rx: 1, fill: 'currentColor', opacity: 0.45 }),
        h('rect', { x: 2.2, y: 7, width: 11.6, height: 2, rx: 1, fill: 'currentColor' }),
        h('rect', { x: 4.6, y: 10.9, width: 9.2, height: 2, rx: 1, fill: 'currentColor', opacity: 0.7 }),
      );
    }

    /** One entry row. */
    function ItemRow({ entry, item, t, onMove, onToggleHidden, onRemove, canMove }) {
      const hidden = item?.hidden === true;
      return h(
        'div',
        { className: `cem-item${hidden ? ' cem-item-hidden' : ''}` },
        h('span', { className: 'cem-item-glyph', 'aria-hidden': 'true' }, h(LogoMark, { size: 14 })),
        h(
          'span',
          { className: 'cem-item-text' },
          h('span', { className: 'cem-item-label', title: entry.id }, entry.label),
          hidden ? h('span', { className: 'cem-item-badge' }, t('item.hiddenBadge')) : null,
        ),
        h(
          'span',
          { className: 'cem-item-actions' },
          canMove === undefined
            ? null
            : [
                h(
                  'button',
                  {
                    key: 'up',
                    type: 'button',
                    className: 'cem-icon-btn',
                    title: t('groups.up'),
                    'aria-label': t('groups.up'),
                    disabled: !canMove.up,
                    onClick: () => onMove(-1),
                  },
                  '↑',
                ),
                h(
                  'button',
                  {
                    key: 'down',
                    type: 'button',
                    className: 'cem-icon-btn',
                    title: t('groups.down'),
                    'aria-label': t('groups.down'),
                    disabled: !canMove.down,
                    onClick: () => onMove(1),
                  },
                  '↓',
                ),
              ],
          h(
            'button',
            {
              type: 'button',
              className: 'cem-icon-btn',
              title: hidden ? t('item.show') : t('item.hide'),
              'aria-label': hidden ? t('item.show') : t('item.hide'),
              'aria-pressed': hidden ? 'true' : 'false',
              onClick: () => onToggleHidden(!hidden),
            },
            hidden ? '⊘' : '◉',
          ),
          onRemove === undefined
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: 'cem-icon-btn',
                  title: t('items.remove'),
                  'aria-label': t('items.remove'),
                  onClick: () => onRemove(),
                },
                '−',
              ),
        ),
      );
    }

    /** One group card in the settings page. */
    function GroupCard({ store, config, group, panels, t }) {
      const [picked, setPicked] = useState('');
      const members = useMemo(
        () =>
          panels
            .filter((panel) => config.items[panel.id]?.group === group.id)
            .sort((a, b) => (config.items[a.id]?.order ?? 0) - (config.items[b.id]?.order ?? 0)),
        [config, group.id, panels],
      );
      const loose = useMemo(
        () =>
          panels.filter((panel) => {
            const item = config.items[panel.id];
            return item === undefined || !config.groups.some((candidate) => candidate.id === item.group);
          }),
        [config, panels],
      );
      const subs = useMemo(
        () => config.groups.filter((candidate) => candidate.level === 2 && candidate.parent === group.id),
        [config, group.id],
      );

      const update = (patch) => {
        store.commit({
          ...config,
          groups: config.groups.map((candidate) =>
            candidate.id === group.id ? { ...candidate, ...patch } : candidate,
          ),
        });
      };

      return h(
        'section',
        { className: 'cem-card', 'data-level': String(group.level) },
        h(
          'header',
          { className: 'cem-card-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'cem-icon-btn',
              title: group.collapsed ? t('groups.expand') : t('groups.collapse'),
              'aria-label': group.collapsed ? t('groups.expand') : t('groups.collapse'),
              'aria-expanded': group.collapsed ? 'false' : 'true',
              onClick: () => update({ collapsed: !group.collapsed }),
            },
            group.collapsed ? '▸' : '▾',
          ),
          h('span', { className: 'cem-card-level' }, t(group.level === 2 ? 'groups.level2' : 'groups.level1')),
          h('input', {
            className: 'cem-input cem-input-name',
            value: group.name,
            placeholder: t('groups.namePlaceholder'),
            'aria-label': t('groups.name'),
            onChange: (event) => update({ name: event.target.value }),
          }),
          h(
            'span',
            { className: 'cem-card-actions' },
            group.level === 1
              ? [
                  h(
                    'button',
                    {
                      key: 'up',
                      type: 'button',
                      className: 'cem-icon-btn',
                      title: t('groups.up'),
                      'aria-label': t('groups.up'),
                      onClick: () => store.commit(moveGroup(store.getSnapshot(), group.id, -1)),
                    },
                    '↑',
                  ),
                  h(
                    'button',
                    {
                      key: 'down',
                      type: 'button',
                      className: 'cem-icon-btn',
                      title: t('groups.down'),
                      'aria-label': t('groups.down'),
                      onClick: () => store.commit(moveGroup(store.getSnapshot(), group.id, 1)),
                    },
                    '↓',
                  ),
                ]
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'cem-icon-btn cem-icon-danger',
                title: t('groups.remove'),
                'aria-label': t('groups.remove'),
                onClick: () => {
                  const current = store.getSnapshot();
                  const items = { ...current.items };
                  for (const [id, item] of Object.entries(items)) {
                    if (item.group === group.id) items[id] = { ...item, group: '' };
                  }
                  const groups = current.groups
                    .filter((candidate) => candidate.id !== group.id)
                    .map((candidate) =>
                      candidate.parent === group.id ? { ...candidate, parent: '' } : candidate,
                    );
                  store.commit({ ...current, groups, items });
                },
              },
              '×',
            ),
          ),
        ),
        group.level === 2
          ? h(
              'label',
              { className: 'cem-field' },
              h('span', { className: 'cem-field-label' }, t('groups.parent')),
              h(
                'select',
                {
                  className: 'cem-select',
                  value: group.parent,
                  onChange: (event) => update({ parent: event.target.value }),
                },
                h('option', { value: '' }, t('groups.parentNone')),
                ...config.groups
                  .filter((candidate) => candidate.level === 1 && candidate.id !== group.id)
                  .map((candidate) =>
                    h('option', { key: candidate.id, value: candidate.id }, candidate.name || candidate.id),
                  ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'cem-items' },
          members.length === 0
            ? h('p', { className: 'cem-muted' }, t('groups.itemsEmpty'))
            : members.map((panel, index) =>
                h(ItemRow, {
                  key: panel.id,
                  entry: panel,
                  item: config.items[panel.id],
                  t,
                  canMove: { up: index > 0, down: index < members.length - 1 },
                  onMove: (delta) => store.commit(moveItem(store.getSnapshot(), panel.id, delta)),
                  onToggleHidden: (hidden) => {
                    const current = store.getSnapshot();
                    const items = { ...current.items };
                    items[panel.id] = {
                      group: group.id,
                      order: items[panel.id]?.order ?? 0,
                      hidden,
                    };
                    store.commit({ ...current, items });
                  },
                  onRemove: () => {
                    const current = store.getSnapshot();
                    const items = { ...current.items };
                    items[panel.id] = { ...(items[panel.id] ?? { order: 0, hidden: false }), group: '' };
                    store.commit({ ...current, items });
                  },
                }),
              ),
        ),
        h(
          'div',
          { className: 'cem-add' },
          h(
            'select',
            {
              className: 'cem-select',
              value: picked,
              'aria-label': t('groups.pick'),
              onChange: (event) => setPicked(event.target.value),
            },
            h('option', { value: '' }, t('groups.pick')),
            ...loose.map((panel) => h('option', { key: panel.id, value: panel.id }, panel.label)),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cem-btn cem-btn-outline',
              disabled: picked === '',
              onClick: () => {
                if (picked === '') return;
                const current = store.getSnapshot();
                const items = { ...current.items };
                items[picked] = {
                  group: group.id,
                  order: nextItemOrder(current, group.id),
                  hidden: items[picked]?.hidden === true,
                };
                store.commit({ ...current, items });
                setPicked('');
              },
            },
            t('groups.addItem'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cem-btn cem-btn-ghost',
              onClick: () => {
                const current = store.getSnapshot();
                const id = nextGroupId(current);
                store.commit({
                  ...current,
                  groups: [
                    ...current.groups,
                    {
                      id,
                      name: '',
                      level: 2,
                      parent: group.level === 1 ? group.id : group.parent,
                      collapsed: false,
                    },
                  ],
                });
              },
            },
            t('groups.addChild'),
          ),
        ),
        subs.length > 0
          ? h('p', { className: 'cem-muted cem-sub-list' }, subs.map((sub) => sub.name || sub.id).join(' · '))
          : null,
      );
    }

    /** The settings section body. */
    function EntryManagerSection({ ctx }) {
      const panels = usePanels(ctx);
      const config = useStoreSnapshot(STORE);
      const [, setLocaleRevision] = useState(0);
      const [confirmReset, setConfirmReset] = useState(false);

      useEffect(() => {
        const locale = ctx.get('locale');
        if (locale === undefined || typeof locale.subscribe !== 'function') return undefined;
        const off = locale.subscribe(() => setLocaleRevision((value) => value + 1));
        return () => {
          try {
            off();
          } catch {
            /* ignore */
          }
        };
      }, [ctx]);

      const t = useCallback((key, params) => translate(ctx, key, params), [ctx]);

      const ungrouped = useMemo(
        () =>
          panels.filter((panel) => {
            const item = config.items[panel.id];
            return item === undefined || !config.groups.some((group) => group.id === item.group);
          }),
        [config, panels],
      );

      const topLevel = config.groups.filter((group) => group.level === 1);
      const orphans = config.groups.filter(
        (group) => group.level === 2 && !config.groups.some((parent) => parent.id === group.parent),
      );

      return h(
        'div',
        { className: 'cem-section' },
        h('h2', { className: 'cem-heading' }, t('title')),
        h('p', { className: 'cem-intro' }, t('intro')),
        h(
          'div',
          { className: 'cem-toolbar' },
          h(UISwitch, {
            checked: config.enabled,
            label: t('toolbar.enable'),
            onChange: (next) => STORE.commit({ ...STORE.getSnapshot(), enabled: next }),
          }),
          h(
            'span',
            { className: 'cem-toolbar-text' },
            h('span', { className: 'cem-toolbar-title' }, t('toolbar.enable')),
            h('span', { className: 'cem-muted' }, t('toolbar.enableHint')),
          ),
          h('span', { className: 'cem-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'cem-btn cem-btn-ghost',
              onClick: () => STORE.replace(STORE.getSnapshot()),
            },
            t('toolbar.rescan'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cem-btn cem-btn-outline',
              onClick: () => {
                if (!confirmReset) {
                  setConfirmReset(true);
                  window.setTimeout(() => setConfirmReset(false), 3000);
                  return;
                }
                setConfirmReset(false);
                STORE.commit(emptyConfig());
              },
            },
            confirmReset ? t('toolbar.resetConfirm') : t('toolbar.reset'),
          ),
        ),
        h('p', { className: 'cem-muted' }, t('detected', { count: panels.length })),
        panels.length === 0 ? h('p', { className: 'cem-muted' }, t('empty.detected')) : null,
        h(
          'div',
          { className: 'cem-groups' },
          h(
            'div',
            { className: 'cem-groups-head' },
            h('h3', { className: 'cem-h3' }, t('groups.title')),
            h(
              'button',
              {
                type: 'button',
                className: 'cem-btn cem-btn-outline',
                onClick: () => {
                  const current = STORE.getSnapshot();
                  const id = nextGroupId(current);
                  STORE.commit({
                    ...current,
                    groups: [...current.groups, { id, name: '', level: 1, parent: '', collapsed: false }],
                  });
                },
              },
              t('groups.add'),
            ),
          ),
          topLevel.length === 0 && orphans.length === 0
            ? h('p', { className: 'cem-muted' }, t('groups.empty'))
            : [...topLevel, ...orphans].map((group) =>
                h(GroupCard, { key: group.id, store: STORE, config, group, panels, t }),
              ),
        ),
        h(
          'div',
          { className: 'cem-groups' },
          h('h3', { className: 'cem-h3' }, t('ungrouped.title')),
          h('p', { className: 'cem-muted' }, t('ungrouped.hint')),
          ungrouped.length === 0
            ? h('p', { className: 'cem-muted' }, t('ungrouped.empty'))
            : h(
                'div',
                { className: 'cem-card cem-card-loose' },
                ungrouped.map((panel) =>
                  h(ItemRow, {
                    key: panel.id,
                    entry: panel,
                    item: config.items[panel.id],
                    t,
                    onToggleHidden: (hidden) => {
                      const current = STORE.getSnapshot();
                      const items = { ...current.items };
                      items[panel.id] = {
                        group: items[panel.id]?.group ?? '',
                        order: items[panel.id]?.order ?? 0,
                        hidden,
                      };
                      STORE.commit({ ...current, items });
                    },
                  }),
                ),
              ),
        ),
        h('p', { className: 'cem-muted cem-footnote' }, t('note.storage')),
      );
    }

    // ─────────────────────────── styles ───────────────────────────

    const CSS = [
      '.cem-group{display:flex;align-items:center;gap:6px;box-sizing:border-box;width:100%;min-height:26px;margin:6px 0 0;padding:1px calc(var(--dsh-sidebar-row-padding,12px) - var(--dsh-sidebar-paint-inset,3px));border:none;border-inline:var(--dsh-sidebar-paint-inset,3px) solid transparent;border-radius:var(--dsw-radius-md);background:padding-box padding-box;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;font-weight:500;line-height:18px;letter-spacing:.02em;text-align:left;cursor:pointer}',
      '@media (hover:hover){.cem-group:hover{color:var(--dsw-alias-label-secondary);background-color:var(--dsw-alias-interactive-bg-hover)}}',
      '.cem-group:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
      '.cem-group[data-cem-level="2"]{padding-left:calc(var(--dsh-sidebar-row-padding,12px) + 14px);font-size:11px;font-weight:400;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}',
      '.cem-group-label{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '.cem-caret{display:inline-flex;align-items:center;justify-content:center;flex:none;width:11px;height:11px;transition:transform .15s var(--ds-ease-in-out,ease)}',
      '.cem-group[aria-expanded="true"] .cem-caret{transform:rotate(90deg)}',
      'nav[data-cem-rail="1"] .cem-group{display:none!important}',
      '.cem-section{display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
      '.cem-heading{margin:0;font-size:18px;font-weight:600;line-height:26px}',
      '.cem-h3{margin:0;font-size:14px;font-weight:600;line-height:22px}',
      '.cem-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}',
      '.cem-muted{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.cem-footnote{margin-top:4px}',
      '.cem-toolbar{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-interactive-bg-hover))}',
      '.cem-toolbar-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.cem-toolbar-title{font-size:14px;line-height:20px}',
      '.cem-spacer{flex:1}',
      '.cem-groups{display:flex;flex-direction:column;gap:10px}',
      '.cem-groups-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.cem-card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}',
      '.cem-card[data-level="2"]{margin-left:20px;border-left:2px solid var(--dsw-alias-border-l3)}',
      '.cem-card-loose{padding:4px 10px}',
      '.cem-card-head{display:flex;align-items:center;gap:8px}',
      '.cem-card-level{flex:none;padding:0 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}',
      '.cem-card-actions{display:flex;align-items:center;gap:2px;flex:none}',
      '.cem-input{box-sizing:border-box;height:30px;min-width:0;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.cem-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:-1px}',
      '.cem-input-name{flex:1}',
      '.cem-select{box-sizing:border-box;height:30px;max-width:100%;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}',
      '.cem-field{display:flex;align-items:center;gap:10px}',
      '.cem-field-label{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.cem-items{display:flex;flex-direction:column;gap:2px}',
      '.cem-item{display:flex;align-items:center;gap:8px;min-height:34px;padding:4px 6px;border-radius:var(--dsw-radius-sm)}',
      '.cem-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.cem-item-hidden{opacity:.55}',
      '.cem-item-glyph{display:inline-flex;align-items:center;justify-content:center;flex:none;width:18px;color:var(--dsw-alias-label-secondary)}',
      '.cem-item-text{display:flex;align-items:center;gap:8px;min-width:0;flex:1}',
      '.cem-item-label{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px;line-height:20px}',
      '.cem-item-badge{flex:none;padding:0 5px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.cem-item-actions{display:flex;align-items:center;gap:2px;flex:none}',
      '.cem-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:1;cursor:pointer}',
      '.cem-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.cem-icon-btn:disabled{opacity:.3;cursor:default}',
      '.cem-icon-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#ef4444)}',
      '.cem-add{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:2px}',
      '.cem-sub-list{padding-left:2px}',
      '.cem-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:28px;padding:0 12px;border:.5px solid transparent;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}',
      '.cem-btn:disabled{opacity:.4;cursor:default}',
      '.cem-btn-outline{border-color:var(--dsw-alias-border-l3)}',
      '.cem-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.cem-btn-ghost{color:var(--dsw-alias-label-secondary)}',
      '.cem-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.cem-switch{position:relative;box-sizing:border-box;width:36px;height:20px;flex:none;padding:0;border:none;border-radius:10px;background:var(--dsw-alias-border-l4,rgba(0,0,0,.16));cursor:pointer;transition:background .15s var(--ds-ease-in-out,ease)}',
      '.cem-switch-on{background:var(--dsw-alias-state-business-primary,#4176e6)}',
      '.cem-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s var(--ds-ease-in-out,ease)}',
      '.cem-switch-on .cem-switch-knob{transform:translateX(16px)}',
    ].join('\n');

    /**
     * Inject the stylesheet once.
     * @returns a disposer removing it.
     */
    function injectStyles() {
      const selector = `style[data-plugin-css="${CSS_TAG}"]`;
      if (document.querySelector(selector) !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-plugins-sidebar-manager';
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    // ─────────────────────────── plugin ───────────────────────────

    /** Section icon: the same three-bar mark, sized by the shell. */
    function SectionIcon({ size = 16 }) {
      return h(LogoMark, { size });
    }

    /**
     * Wake the browser mirror from the host document when the browser has
     * nothing of its own yet, so a fresh browser profile inherits the layout.
     * @param store - the configuration store.
     */
    async function hydrateFromHost(store) {
      try {
        if (window.localStorage.getItem(STORAGE_KEY) !== null) return;
      } catch {
        return;
      }
      try {
        const response = await fetch(`${API}/config`, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) return;
        const body = await response.json();
        const document = body?.document;
        if (document === null || typeof document !== 'object' || Array.isArray(document)) return;
        if (Object.keys(document).length === 0) return;
        store.replace(document);
      } catch {
        /* the host half may not be mounted on this build */
      }
    }

    /**
     * Mount the sidebar enhancer and the settings section.
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => injectStyles(), 'plugins-sidebar-manager: styles');
      ctx.effect(() => startEnhancer(ctx, STORE), 'plugins-sidebar-manager: sidebar');
      ctx.effect(() => {
        void hydrateFromHost(STORE);
        return undefined;
      }, 'plugins-sidebar-manager: hydrate');

      if (typeof ctx.slots?.inject !== 'function') return;

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: SECTION_ORDER,
            label: () => translate(ctx, 'nav'),
          },
          (ownerProps) => h(EntryManagerSection, { ...ownerProps, ctx }),
        ),
      );
      ctx.slots.inject('settings.section.icon', () =>
        ctx.slots.register({ name: 'settings.section.icon', id: SECTION_ID }, SectionIcon),
      );
    }

    return {
      inject: ['slots'],
      apply,
    };
  },
});
