// dsh-ocgo-lite — Client half
// 聊天输入框下方常驻用量条(composer.dock):GO 徽标 + 三个配额圆环 + token + 金额,
// 每个区块点击弹出各自炫酷详情卡片(Portal 到 body,全部内联样式,不依赖 CSS 注入)。
window.__ModuleLoader__.load({
  id: "dsh-ocgo-lite",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const ReactDOM = require("react-dom");

    const inject = ["slots"];
    const API = "/ocgo-lite/api";

    // 少量增强样式(仅 hover;核心布局与卡片样式全部内联,不依赖注入成功)
    const CSS = `
.ocgo-lite .seg:hover { background: rgba(128,128,128,.12); }
.ocgo-lite-detail .btn:hover { background: rgba(76,125,255,.12); border-color: rgba(76,125,255,.6); }
`;

    function fmtInt(n) {
      n = Number(n);
      if (isNaN(n)) return "-";
      // 完整数字 + 千分位(如 604,500,000),不缩写
      return Math.round(n).toLocaleString("en-US");
    }
    // 紧凑缩写(模型明细行用):356,380 → 0.4M / 35,319 → 35.3K,一行塞下
    function fmtCompact(n) {
      n = Number(n);
      if (isNaN(n)) return "-";
      if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
      if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
      return String(Math.round(n));
    }
    function fmtUsd(v) {
      v = Number(v);
      return isNaN(v) ? "-" : "$" + v.toFixed(2);
    }
    function fmtReset(iso) {
      if (!iso) return "未知";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      const diff = d.getTime() - Date.now();
      if (diff <= 0) return "已重置";
      const day = Math.floor(diff / 86400e3);
      const h = Math.floor((diff % 86400e3) / 3600e3);
      const m = Math.floor((diff % 3600e3) / 60e3);
      if (day > 0) return day + " 天 " + h + " 小时";
      if (h > 0) return h + " 小时 " + m + " 分";
      return m + " 分钟";
    }
    function pctOf(w) { return w && typeof w.percent === "number" ? w.percent : null; }
    function ringColor(p) { return p == null ? "#888" : p >= 90 ? "#e5484d" : p >= 70 ? "#e08a3c" : "#4c7dff"; }
    function fmtClock(ts) {
      if (!ts) return "-";
      const d = new Date(ts);
      if (isNaN(d.getTime())) return "-";
      const p = (x) => String(x).padStart(2, "0");
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }
    // 日期时间(用于定价更新等跨天时间):MM-DD HH:MM
    function fmtDT(iso) {
      if (!iso) return "-";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      const p = (x) => String(x).padStart(2, "0");
      return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    // SVG 圆环:外圈底色 + 内圈进度,中心数字用 HTML 叠加(保证显示,不依赖 SVG text 渲染)
    function Ring(props) {
      const { percent, color } = props;
      const p = percent == null ? 0 : Math.max(0, Math.min(100, percent));
      const R = 9, C = 2 * Math.PI * R;
      const filled = (p / 100) * C;
      const label = percent == null ? "-" : Math.round(percent) + "%";
      return React.createElement("span", {
        style: { position: "relative", display: "inline-block", width: 26, height: 26, flex: "none" },
      },
        React.createElement("svg", { width: 26, height: 26, viewBox: "0 0 26 26" },
          React.createElement("circle", { cx: 13, cy: 13, r: R, fill: "none", stroke: "rgba(128,128,128,.18)", strokeWidth: 3 }),
          React.createElement("circle", {
            cx: 13, cy: 13, r: R, fill: "none",
            stroke: color, strokeWidth: 3,
            strokeLinecap: "round",
            strokeDasharray: C + " " + C,
            strokeDashoffset: C - filled,
            transform: "rotate(-90 13 13)",
          })),
        React.createElement("span", {
          style: {
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 7, fontWeight: 700, color: color,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1, pointerEvents: "none",
          },
        }, label));
    }

    // 模块级共享缓存:跨会话实例共享数据,切换会话时立即显示旧数据再后台刷新(避免白屏等待)
    let sharedData = null;
    let sharedAt = 0;

    // 模块级会话配置记忆:每个会话独立记住「范围 + 模型」选择;
    // 切走再切回时恢复该会话自己的配置,互不影响(跨组件实例存活)
    const sessionPrefs = new Map();

    function OcgoLite(props) {
      // 当前会话 ID(来自 composer.dock 槽位 props;用于"本次会话"切换与配置记忆)
      const sessionId = (props && props.sessionId) || null;
      const [data, setData] = React.useState(sharedData);
      const [loading, setLoading] = React.useState(!sharedData);
      // 当前展开详情的区块:null=收起;pop={key, rect}
      const [pop, setPop] = React.useState(null);
      // 弹出动画态:挂载后下一帧切 true,触发 opacity/transform 过渡
      const [show, setShow] = React.useState(false);
      // 最后成功更新时间戳
      const [lastUpdated, setLastUpdated] = React.useState(sharedAt || null);
      // 是否已加载过:首次加载显示 loading,后续刷新无感(不闪 loading)
      const loadedRef = React.useRef(!!sharedData);
      // 状态条容器 ref + 卡片 ref:用于"点击外部关闭"
      const wrapRef = React.useRef(null);
      // 复制 API Key 的反馈状态(必须在组件顶层,不能在条件分支里)
      const [copied, setCopied] = React.useState(false);
      // 弹窗提示(复制成功等)
      const [toast, setToast] = React.useState(null);
      // 选中的模型:null=全部;选中后状态条 token/花费联动显示该模型
      // 统计范围:'all'=全部会话 / 'session'=本次会话
      // 两者初值取自该会话的记忆配置(无记忆则默认 全部/全部)
      const savedPrefs = sessionId ? sessionPrefs.get(sessionId) : null;
      const [modelSel, setModelSel] = React.useState(savedPrefs ? savedPrefs.model : null);
      const [scope, setScope] = React.useState(savedPrefs ? savedPrefs.scope : 'all');
      // 切会话(组件复用或重挂):恢复该会话记忆的配置
      React.useEffect(() => {
        if (!sessionId) return;
        const p = sessionPrefs.get(sessionId);
        if (p) {
          setScope(p.scope);
          setModelSel(p.model);
        }
      }, [sessionId]);
      // 配置变更:写回该会话的记忆(切走再切回仍保留)
      React.useEffect(() => {
        if (!sessionId) return;
        sessionPrefs.set(sessionId, { scope, model: modelSel });
      }, [sessionId, scope, modelSel]);

      // 复制文本到剪贴板:clipboard API 优先,失败回退 execCommand(兼容无权限场景)
      const copyText = (text) => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text).catch(() => {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand("copy"); } catch { /* ignore */ }
            document.body.removeChild(ta);
          });
        }
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch { /* ignore */ }
        document.body.removeChild(ta);
        return Promise.resolve();
      };
      // 显示 toast 提示,1.5s 后消失
      const showToast = (msg) => {
        setToast(msg);
        setTimeout(() => setToast(null), 1500);
      };

      // 点击页面其他地方关闭详情卡片(卡片用 closest 标记,点击卡片内部不关闭)
      React.useEffect(() => {
        if (!pop) return;
        const onDocClick = (e) => {
          const t = e.target;
          if (wrapRef.current && wrapRef.current.contains(t)) return;
          if (t && t.closest && t.closest(".ocgo-detail")) return;
          setPop(null);
        };
        document.addEventListener("click", onDocClick, true);
        return () => document.removeEventListener("click", onDocClick, true);
      }, [pop]);

      const load = React.useCallback(() => {
        if (!loadedRef.current) setLoading(true);
        // live=<sessionId>:本次会话实时通道(Host 只重读该会话文件,跳过 5 分钟缓存)
        fetch(API + (sessionId ? "?live=" + encodeURIComponent(sessionId) : ""), { headers: { Accept: "application/json" } })
          .then((res) => res.json())
          .then((res) => {
            loadedRef.current = true;
            sharedData = res || null;
            sharedAt = Date.now();
            setData(res || null);
            setLastUpdated(Date.now());
            setLoading(false);
          })
          .catch((e) => { loadedRef.current = true; setData({ ok: false, error: String((e && e.message) || e) }); setLoading(false); });
      }, [sessionId]);
      React.useEffect(() => { load(); }, [load]);
      // 30s 自动刷新(无感:不闪 loading)
      React.useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
      // 弹出动画:pop 变化时先隐藏,下一帧过渡到显示(必须无条件调用,保持 hooks 顺序稳定)
      React.useEffect(() => {
        if (!pop) return;
        setShow(false);
        const raf = requestAnimationFrame(() => requestAnimationFrame(() => setShow(true)));
        return () => cancelAnimationFrame(raf);
      }, [pop]);

      if (!data || loading) {
        return React.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--dsw-alias-label-secondary, #888)", whiteSpace: "nowrap" } },
          React.createElement("span", null, "OpenCode Go …"));
      }
      if (!data.ok) {
        return React.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 10, whiteSpace: "nowrap" } },
          React.createElement("span", { style: { color: "#e5484d", fontWeight: 700 } }, "GO:不可用"),
          React.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary, #888)" } }, String(data.error || "err")),
          React.createElement("button", { onClick: load, style: { border: "1px solid rgba(128,128,128,.35)", background: "transparent", color: "inherit", borderRadius: 6, padding: "2px 8px", fontSize: 10, cursor: "pointer" } }, "重试"));
      }

      const q = data.quota || {};
      const rp = pctOf(q.rolling), wp = pctOf(q.weekly), mp = pctOf(q.monthly);
      const s = data.stats || {};
      const t = s.tokens || {};
      const total = (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);
      // 范围联动:本次会话优先;按模型联动其次;都未选中显示全部。
      // scope: 'all'=全部会话 / 'session'=本次会话 / 'recent'=最近对话(最近活跃会话)
      const scoped = scope === "session" || scope === "recent"; // 是否限定了单个会话
      const bsList = (s && s.bySession) || [];
      // 会话 id 存在两种格式(裸 uuid / session- 前缀),双向匹配兜底
      // currentSession:当前 GUI 会话(范围卡片"本次会话"行展示用,与当前 scope 无关)
      const currentSession = sessionId ? (
        bsList.find((b) => b.sessionId === sessionId)
        || bsList.find((b) => b.sessionId === "session-" + sessionId)
        || bsList.find((b) => b.sessionId === sessionId.replace(/^session-/, ""))
      ) : null;
      // curSession:当前范围选中的会话(口径计算用)。
      // 'recent'=**当前会话**最后一次任务(lastTurn)的执行消耗(含正在执行的任务)
      const curSession = scope === "session"
        ? currentSession
        : scope === "recent"
          ? (() => {
              if (!currentSession || !currentSession.lastTurn) return currentSession || null;
              return { ...currentSession, tokens: currentSession.lastTurn.tokens, cost: currentSession.lastTurn.cost, requests: currentSession.lastTurn.requests, byModel: currentSession.lastTurn.byModel };
            })()
          : null;
      const bmList = (s && s.byModel) || [];
      const sumTok = (tt) => (tt.input || 0) + (tt.output || 0) + (tt.reasoning || 0) + (tt.cacheRead || 0) + (tt.cacheWrite || 0);
      // 范围=本次会话/最近对话时,模型联动/模型选择/明细均基于该会话的模型列表
      const curModels = (curSession && curSession.byModel) || [];
      const modelList = scoped ? curModels : bmList;
      const selModel = modelSel ? modelList.find((m) => m.model === modelSel) : null;
      // 当前范围口径下的总量/花费(模型"全部"行与明细标题用):全部=全局合计;限定会话无记录则为 0
      const scopeTotal = scoped ? (curSession ? sumTok(curSession.tokens) : 0) : total;
      const scopeCost = scoped ? (curSession ? curSession.cost : 0) : s.cost;
      // 范围+模型双层联动:限定会话时,选中模型则显示该模型在该会话的量,未选则显示该会话总量
      const shownTotal = scoped
        ? (curSession ? (selModel ? sumTok(selModel.tokens) : scopeTotal) : 0)
        : (selModel ? sumTok(selModel.tokens) : total);
      const shownCost = scoped
        ? (curSession ? (selModel ? selModel.cost : scopeCost) : 0)
        : (selModel ? selModel.cost : s.cost);
      // 范围中文标签(状态条/卡片标注共用)
      const scopeLabel = scope === "session" ? "本次会话" : (scope === "recent" ? "最近对话" : "全部");

      // 常驻条:GO 徽标 + 三个配额区块(标签在前,圆环在后) + token 区块 + 金额区块
      // 关键布局全部内联样式(不依赖 CSS 类注入,保证 flex 单行不换行);区块间两个空格
      const segBox = { display: "inline-flex", alignItems: "center", gap: 3, cursor: "pointer", padding: "2px 5px", borderRadius: 6, whiteSpace: "nowrap" };
      const sepBox = { width: 5, flex: "none" }; // 区块间两个空格宽度的分隔(缩短一半)
      const seg = (key, children) =>
        React.createElement("span", {
          style: segBox,
          onClick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setPop(pop && pop.key === key ? null : { key, rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
          },
        }, children);

      const bar = React.createElement("span", { ref: wrapRef, style: { display: "inline-flex", alignItems: "center", gap: 0, whiteSpace: "nowrap", fontSize: 10, color: "var(--dsw-alias-label-secondary, #888)" } },
        React.createElement("span", {
          style: { fontWeight: 800, fontSize: 9, letterSpacing: ".06em", padding: "1px 5px", borderRadius: 5, color: "#4c7dff", background: "rgba(76,125,255,.14)", flex: "none", cursor: "pointer" },
          onClick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setPop(pop && pop.key === "account" ? null : { key: "account", rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
          },
        }, "GO:"),
        React.createElement("span", { style: sepBox }),
        seg("quota-rolling", [
          React.createElement("span", { key: "l", style: { color: "rgba(128,128,128,.8)" } }, "滚动："),
          React.createElement(Ring, { key: "r", percent: rp, color: ringColor(rp) }),
        ]),
        React.createElement("span", { style: sepBox }),
        seg("quota-weekly", [
          React.createElement("span", { key: "l", style: { color: "rgba(128,128,128,.8)" } }, "周："),
          React.createElement(Ring, { key: "r", percent: wp, color: ringColor(wp) }),
        ]),
        React.createElement("span", { style: sepBox }),
        seg("quota-monthly", [
          React.createElement("span", { key: "l", style: { color: "rgba(128,128,128,.8)" } }, "月："),
          React.createElement(Ring, { key: "r", percent: mp, color: ringColor(mp) }),
        ]),
        React.createElement("span", { style: sepBox }),
        seg("scope", [
          React.createElement("span", { key: "l", style: { color: "rgba(128,128,128,.8)" } }, "范围："),
          React.createElement("span", { key: "b", style: { fontWeight: 700, color: "var(--dsw-alias-label-primary, inherit)", fontVariantNumeric: "tabular-nums" } }, scopeLabel),
        ]),
        React.createElement("span", { style: sepBox }),
        seg("model", [
          React.createElement("span", { key: "l", style: { color: "rgba(128,128,128,.8)" } }, "模型："),
          React.createElement("span", { key: "b", style: { fontWeight: 700, color: "var(--dsw-alias-label-primary, inherit)", fontVariantNumeric: "tabular-nums" } }, modelSel || "全部"),
        ]),
        React.createElement("span", { style: sepBox }),
        seg("token", [
          React.createElement("span", { key: "l", style: { color: "rgba(128,128,128,.8)" } }, "token："),
          React.createElement("span", { key: "b", style: { fontWeight: 700, color: "var(--dsw-alias-label-primary, inherit)", fontVariantNumeric: "tabular-nums" } }, fmtInt(shownTotal)),
        ]),
        React.createElement("span", { style: sepBox }),
        seg("money", [
          React.createElement("span", { key: "l", style: { color: "rgba(128,128,128,.8)" } }, "花费："),
          React.createElement("span", { key: "b", style: { fontWeight: 700, color: "var(--dsw-alias-label-primary, inherit)", fontVariantNumeric: "tabular-nums" } }, fmtUsd(shownCost)),
        ]));

      if (!pop) return bar;

      // 卡片定位:被点区块正上方,水平居中;箭头指向区块中心
      // token/花费卡片更窄(内容紧凑),配额卡片 300px
      const rect = pop.rect || { left: 0, top: 0, width: 100, height: 20 };
      const cardW = pop.key === "token" ? 250 : (pop.key === "money" ? 200 : 300);
      const cardLeft = Math.max(8, Math.min(rect.left + rect.width / 2 - cardW / 2, window.innerWidth - cardW - 8));
      const cardBottom = window.innerHeight - rect.top + 8;
      const arrowLeft = rect.left + rect.width / 2 - cardLeft; // 箭头相对卡片左边缘

      // 卡片公共样式(全内联,不依赖 CSS 注入)
      const cardBase = {
        position: "fixed",
        left: cardLeft,
        bottom: cardBottom,
        width: cardW,
        maxWidth: "90vw",
        background: "linear-gradient(160deg, rgba(76,125,255,.09), transparent 55%), var(--dsw-alias-bg-overlay, #ffffff)",
        border: "1px solid rgba(76,125,255,.38)",
        borderRadius: 12,
        boxShadow: "0 18px 48px rgba(0,0,0,.30), 0 0 0 1px rgba(76,125,255,.07), 0 0 28px rgba(76,125,255,.14)",
        padding: "12px 14px",
        fontSize: 11,
        color: "var(--dsw-alias-label-secondary, #555)",
        zIndex: 9999,
        opacity: show ? 1 : 0,
        transform: show ? "none" : "translateY(10px) scale(.94)",
        transition: "opacity .18s cubic-bezier(.2,.9,.3,1.15), transform .18s cubic-bezier(.2,.9,.3,1.15)",
        transformOrigin: "center bottom",
        boxSizing: "border-box",
        maxHeight: "70vh",
        overflowY: "auto",
      };
      const rowStyle = { display: "flex", justifyContent: "space-between", gap: 8, padding: "2px 0" };
      const bStyle = { fontWeight: 700, color: "var(--dsw-alias-label-primary, #222)", fontVariantNumeric: "tabular-nums" };
      const btnStyle = { border: "1px solid rgba(76,125,255,.35)", background: "transparent", color: "var(--dsw-alias-label-primary, inherit)", borderRadius: 6, padding: "3px 10px", fontSize: 11, cursor: "pointer" };
      const h4Style = { margin: "0 0 8px", fontSize: 11, fontWeight: 700, color: "var(--dsw-alias-label-primary, #222)" };
      const barStyle = { height: 5, borderRadius: 3, background: "rgba(128,128,128,.2)", overflow: "hidden", margin: "2px 0 6px" };
      const footStyle = { fontSize: 10, opacity: .55, marginTop: 6 };

      const popKey = pop.key;
      let content = null;
      if (popKey === "model") {
        // 模型选择卡片:全部 + 消耗过的模型;范围=本次会话时只列本次会话的模型
        const modelRow = (label, m) => {
          const mt = m ? (m.tokens || {}) : (scoped ? ((curSession && curSession.tokens) || {}) : t);
          const mTotal = sumTok(mt);
          const mCost = m ? m.cost : scopeCost;
          const active = (m ? m.model : null) === modelSel;
          return React.createElement("div", {
            key: label,
            style: Object.assign({ padding: "4px 6px", borderRadius: 6, cursor: "pointer" }, active ? { background: "rgba(76,125,255,.14)" } : {}),
            onClick: (e) => { e.stopPropagation(); setModelSel(m ? m.model : null); setPop(null); },
          },
            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", gap: 8 } },
              React.createElement("span", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary, #222)", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label + (active ? " ✓" : "")),
              React.createElement("span", { style: bStyle }, fmtUsd(mCost))),
            React.createElement("div", { style: { fontSize: 10, opacity: .7, paddingTop: 1 } }, "token " + fmtCompact(mTotal)));
        };
        const rows = [modelRow("全部（合计）", null)];
        modelList.forEach((m) => rows.push(modelRow(m.model, m)));
        content = React.createElement(React.Fragment, null,
          React.createElement("div", { style: h4Style }, "选择模型" + (scoped ? " · " + scopeLabel : "")),
          rows,
          modelList.length ? React.createElement("div", { style: footStyle }, "选择后状态条 token/花费联动显示该模型") : React.createElement("div", { style: footStyle }, "本次会话暂无模型用量"),
          React.createElement("div", { style: Object.assign({}, rowStyle, { marginTop: 6 }) },
            React.createElement("button", { style: btnStyle, onClick: (e) => { e.stopPropagation(); setPop(null); } }, "收起")));
      } else if (popKey === "scope") {
        // 范围选择卡片:全部会话 / 本次会话 / 最近对话;选择后状态条 token/花费联动显示
        const scopeVal = (key) => {
          if (key === "session") return currentSession ? fmtInt(sumTok(currentSession.tokens)) + " · " + fmtUsd(currentSession.cost) : "暂无记录";
          if (key === "recent") {
            const lt = currentSession && currentSession.lastTurn;
            return lt ? fmtInt(sumTok(lt.tokens)) + " · " + fmtUsd(lt.cost) : "暂无记录";
          }
          return fmtInt(total) + " · " + fmtUsd(s.cost);
        };
        const scopeRow = (key, label, sub) => {
          const active = scope === key;
          return React.createElement("div", {
            key: key,
            style: Object.assign({ padding: "4px 6px", borderRadius: 6, cursor: "pointer" }, active ? { background: "rgba(76,125,255,.14)" } : {}),
            onClick: (e) => {
              e.stopPropagation();
              setScope(key);
              // 切到限定会话范围时:单模型自动选中该模型;多模型/无记录则回到"全部"
              if (key !== "all") {
                let target = null;
                if (key === "session") {
                  target = currentSession;
                } else {
                  target = (currentSession && currentSession.lastTurn) ? { ...currentSession, byModel: currentSession.lastTurn.byModel } : currentSession;
                }
                const ms = (target && target.byModel) || [];
                if (ms.length === 1) setModelSel(ms[0].model);
                else setModelSel(null);
              }
              setPop(null);
            },
          },
            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", gap: 8 } },
              React.createElement("span", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary, #222)" } }, label + (active ? " ✓" : "")),
              React.createElement("span", { style: bStyle }, scopeVal(key))),
            React.createElement("div", { style: { fontSize: 10, opacity: .7, paddingTop: 1 } }, sub));
        };
        content = React.createElement(React.Fragment, null,
          React.createElement("div", { style: h4Style }, "统计范围"),
          scopeRow("all", "全部", "所有 DSH 会话合计（opencode-go 流量）"),
          scopeRow("session", "本次会话", currentSession ? "当前聊天会话累计的 token 与花费" : "当前会话暂无用量记录（显示 0）"),
          scopeRow("recent", "最近对话", (currentSession && currentSession.lastTurn) ? "当前会话「最后一次任务」的执行消耗（含正在执行的任务）" : "当前会话暂无用量记录（显示 0）"),
          React.createElement("div", { style: Object.assign({}, rowStyle, { marginTop: 6 }) },
            React.createElement("button", { style: btnStyle, onClick: (e) => { e.stopPropagation(); setPop(null); } }, "收起")));
      } else if (popKey === "quota-rolling" || popKey === "quota-weekly" || popKey === "quota-monthly") {
        const winDefs = [
          ["5 小时滚动", q.rolling, "#4c7dff", popKey === "quota-rolling"],
          ["每周", q.weekly, "#2fbf71", popKey === "quota-weekly"],
          ["每月", q.monthly, "#e08a3c", popKey === "quota-monthly"],
        ];
        const rows = [];
        winDefs.forEach(([label, w, color, active]) => {
          const p = pctOf(w);
          rows.push(React.createElement("div", { key: label, style: { marginBottom: 4, opacity: active ? 1 : 0.75 } },
            React.createElement("div", { style: rowStyle },
              React.createElement("span", null, label + (active ? " ▼" : "")),
              React.createElement("span", { style: bStyle },
                (p == null ? "-" : p + "% 已用") + " 重置 " + fmtReset(w && w.resetsAt))),
            React.createElement("div", { style: barStyle },
              React.createElement("i", { style: { display: "block", height: "100%", borderRadius: 3, width: (p == null ? 0 : Math.min(100, p)) + "%", background: color } }))));
        });
        content = React.createElement(React.Fragment, null,
          React.createElement("div", { style: h4Style }, "套餐余量"),
          rows,
          React.createElement("div", { style: footStyle }, "官方配额 · 账户级（含其他设备/软件）"),
          React.createElement("div", { style: Object.assign({}, rowStyle, { marginTop: 6 }) },
            React.createElement("button", { style: btnStyle, onClick: (e) => { e.stopPropagation(); load(); } }, loading ? "刷新中…" : "刷新"),
            React.createElement("button", { style: btnStyle, onClick: (e) => { e.stopPropagation(); setPop(null); } }, "收起")),
          React.createElement("div", { style: footStyle }, "更新于 " + fmtClock(lastUpdated) + " · 自动刷新 30 秒"));
      } else if (popKey === "token") {
        // 口径跟随当前选择:选中模型 → 该模型;否则按范围(本次会话/全部)
        const cardTok = selModel ? (selModel.tokens || {}) : (scoped ? (curSession ? curSession.tokens : {}) : t);
        const cardTotal = selModel ? sumTok(selModel.tokens) : scopeTotal;
        const cardTitle = selModel
          ? "模型 " + selModel.model
          : (scoped ? scopeLabel + "总消耗" : "总消耗 token");
        const cardModels = selModel ? [selModel] : modelList;
        const rows = [
          ["输入：", fmtInt(cardTok.input)], ["输出：", fmtInt(cardTok.output)], ["推理：", fmtInt(cardTok.reasoning)],
          ["缓存读：", fmtInt(cardTok.cacheRead)], ["缓存写：", fmtInt(cardTok.cacheWrite)],
        ].map(([k, v]) =>
          React.createElement("div", { key: k, style: { display: "flex", justifyContent: "space-between", gap: 16, padding: "1px 0" } },
            React.createElement("span", null, k),
            React.createElement("span", { style: bStyle }, v)));
        // 按模型分组(token 明细;跟随模型选择与范围)
        const modelRows = cardModels.map((m) => {
          const mt = (m.tokens || {});
          const mTotal = sumTok(mt);
          return React.createElement("div", { key: m.model, style: { padding: "3px 0", borderTop: "1px solid rgba(128,128,128,.12)" } },
            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", gap: 8 } },
              React.createElement("span", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary, #222)" } }, m.model),
              React.createElement("span", { style: bStyle }, fmtInt(mTotal))),
            React.createElement("div", { style: { fontSize: 10, opacity: .7, paddingTop: 1 } },
              "输入 " + fmtCompact(mt.input) + " · 输出 " + fmtCompact(mt.output) + " · 缓存 " + fmtCompact(mt.cacheRead)));
        });
        content = React.createElement(React.Fragment, null,
          React.createElement("div", { style: h4Style }, cardTitle + "  " + fmtInt(cardTotal)),
          rows,
          cardModels.length ? React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: "var(--dsw-alias-label-tertiary, #888)", marginTop: 6 } }, "按模型" + (selModel ? "（仅所选模型）" : (scoped ? "（" + scopeLabel + "）" : ""))) : null,
          modelRows,
          React.createElement("div", { style: footStyle }, "仅统计 DSH 会话（opencode-go 流量）· 范围：" + scopeLabel + (selModel ? " · 模型：" + selModel.model : "")),
          React.createElement("div", { style: Object.assign({}, rowStyle, { marginTop: 6 }) },
            React.createElement("button", { style: btnStyle, onClick: (e) => { e.stopPropagation(); load(); } }, loading ? "刷新中…" : "刷新"),
            React.createElement("button", { style: btnStyle, onClick: (e) => { e.stopPropagation(); setPop(null); } }, "收起")),
          React.createElement("div", { style: footStyle }, "更新于 " + fmtClock(lastUpdated) + " · 自动刷新 30 秒"));
      } else if (popKey === "account") {
        // 账户卡片:API key 无用户身份信息,显示套餐/配额概览 + key 掩码 + 复制
        const winRows = [
          ["5 小时滚动", rp], ["每周", wp], ["每月", mp],
        ].map(([label, p]) =>
          React.createElement("div", { key: label, style: rowStyle },
            React.createElement("span", null, label + "："),
            React.createElement("span", { style: bStyle }, p == null ? "-" : p + "%")));
        const acct = (data && data.account) || {};
        const keyMask = acct.keyMask || "sk-…";
        const copyKey = () => {
          fetch("/ocgo-lite/key", { headers: { Accept: "application/json" } })
            .then((r) => r.json())
            .then((res) => {
              if (res && res.ok && res.key) {
                return copyText(res.key).then(() => {
                  setCopied(true);
                  showToast("API Key 已复制到剪贴板 ✓");
                  setTimeout(() => setCopied(false), 1500);
                });
              }
              showToast("复制失败：未获取到 Key");
            })
            .catch(() => showToast("复制失败"));
        };
        content = React.createElement(React.Fragment, null,
          React.createElement("div", { style: h4Style }, "OpenCode Go 账户"),
          React.createElement("div", { style: rowStyle }, React.createElement("span", null, "登录状态："),
            React.createElement("span", { style: bStyle }, data && data.ok ? "已登录 ✓" : "未登录")),
          React.createElement("div", { style: rowStyle }, React.createElement("span", null, "套餐："),
            React.createElement("span", { style: bStyle }, "Go 订阅")),
          winRows,
          React.createElement("div", { style: rowStyle }, React.createElement("span", null, "API Key："),
            React.createElement("span", { style: { fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-primary, #222)" } }, keyMask)),
          React.createElement("div", { style: Object.assign({}, rowStyle, { marginTop: 4 }) },
            React.createElement("button", { style: btnStyle, onClick: (e) => { e.stopPropagation(); copyKey(); } }, copied ? "已复制 ✓" : "复制 API Key")),
          React.createElement("div", { style: Object.assign({}, rowStyle, { marginTop: 6 }) },
            React.createElement("button", { style: btnStyle, onClick: (e) => { e.stopPropagation(); load(); } }, loading ? "刷新中…" : "刷新"),
            React.createElement("button", { style: btnStyle, onClick: (e) => { e.stopPropagation(); setPop(null); } }, "收起")),
          React.createElement("div", { style: footStyle }, "更新于 " + fmtClock(lastUpdated) + " · 自动刷新 30 秒"));
      } else if (popKey === "money") {
        // 按模型花费排行(降序)+ 占比条;范围=本次会话时只列本次会话的模型
        // 口径跟随当前选择:选中模型 → 该模型;否则按范围(本次会话/全部)
        const bm = selModel ? [selModel] : modelList;
        const cardCost = selModel ? selModel.cost : scopeCost;
        const cardSessions = selModel ? selModel.requests : (scoped ? (curSession ? 1 : 0) : (s.sessions == null ? "-" : s.sessions));
        const maxCost = bm.length ? Math.max.apply(null, bm.map((m) => m.cost)) : 0;
        const fmtPrice = (p) => (p ? "$" + p.in + "/" + p.out + "/" + p.cr + " 每百万" : "定价未知");
        const modelCostRows = bm.map((m) =>
          React.createElement("div", { key: m.model, style: { padding: "2px 0" } },
            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", gap: 8 } },
              React.createElement("span", { style: { maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, m.model),
              React.createElement("span", { style: bStyle }, fmtUsd(m.cost))),
            React.createElement("div", { style: { height: 4, borderRadius: 2, background: "rgba(128,128,128,.18)", overflow: "hidden", marginTop: 2 } },
              React.createElement("div", { style: { height: "100%", width: maxCost > 0 ? Math.max(2, (m.cost / maxCost) * 100) + "%" : "0%", background: "#4c7dff", borderRadius: 2 } })),
            React.createElement("div", { style: { fontSize: 9, opacity: .6, paddingTop: 1 } }, fmtPrice(m.price))));
        content = React.createElement(React.Fragment, null,
          React.createElement("div", { style: h4Style }, "消耗金额" + (selModel ? " · " + selModel.model : (scoped ? " · " + scopeLabel : ""))),
          React.createElement("div", { style: rowStyle }, React.createElement("span", null, "累计："),
            React.createElement("span", { style: bStyle }, fmtUsd(cardCost) + " 美元")),
          React.createElement("div", { style: rowStyle }, React.createElement("span", null, "会话数："),
            React.createElement("span", { style: bStyle }, cardSessions)),
          bm.length ? React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: "var(--dsw-alias-label-tertiary, #888)", marginTop: 6 } }, "按模型（花费）" + (selModel ? "（仅所选模型）" : (scoped ? " · " + scopeLabel : ""))) : null,
          modelCostRows,
          React.createElement("div", { style: footStyle }, "仅 DSH 会话 · 按官方定价估算 · 范围：" + scopeLabel + (selModel ? " · 模型：" + selModel.model : "")),
          React.createElement("div", { style: footStyle }, "定价更新于 " + fmtDT(data && data.meta && data.meta.pricingUpdatedAt)),
          React.createElement("div", { style: Object.assign({}, rowStyle, { marginTop: 6 }) },
            React.createElement("button", { style: btnStyle, onClick: (e) => { e.stopPropagation(); load(); } }, loading ? "刷新中…" : "刷新"),
            React.createElement("button", { style: btnStyle, onClick: (e) => { e.stopPropagation(); setPop(null); } }, "收起")),
          React.createElement("div", { style: footStyle }, "更新于 " + fmtClock(lastUpdated) + " · 自动刷新 30 秒"));
      }

      // 箭头(内联三角,指向被点区块)
      const arrow = React.createElement("div", {
        style: {
          position: "absolute",
          bottom: -7,
          left: arrowLeft - 7,
          width: 0, height: 0,
          borderLeft: "7px solid transparent",
          borderRight: "7px solid transparent",
          borderTop: "7px solid var(--dsw-alias-bg-overlay, #ffffff)",
          filter: "drop-shadow(0 2px 2px rgba(76,125,255,.25))",
          pointerEvents: "none",
        },
      });

      const card = React.createElement("div", { className: "ocgo-detail", style: cardBase, onClick: (e) => e.stopPropagation() },
        content,
        arrow);

      // 复制成功 toast(固定定位顶部居中,渐入渐出)
      let toastEl = null;
      if (toast) {
        toastEl = ReactDOM.createPortal(
          React.createElement("div", {
            style: {
              position: "fixed",
              top: 24,
              left: "50%",
              transform: "translateX(-50%)",
              background: "rgba(46,125,50,.95)",
              color: "#fff",
              padding: "8px 18px",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              boxShadow: "0 6px 20px rgba(0,0,0,.25)",
              zIndex: 100000,
              pointerEvents: "none",
            },
          }, toast),
          document.body);
      }

      // Portal 到 body:彻底脱离 dock 容器的 transform/overflow 影响
      return React.createElement(React.Fragment, null,
        bar,
        ReactDOM.createPortal(card, document.body),
        toastEl);
    }

    function apply(ctx) {
      // 注入样式:闭包持有自己的 style 引用,热重载时只清理自己创建的实例,
      // 绝不再按固定 id 查找(旧版按 id 删除会把新注入的 style 也删掉,导致 CSS 类全部失效)
      try {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);
        ctx.effect(() => { try { style.remove(); } catch { /* ignore */ } }, "ocgo-lite: css");
      } catch { /* ignore */ }

      ctx.effect(() => ctx.slots.inject("conversation.composer.dock", () =>
        ctx.slots.register({
          name: "conversation.composer.dock",
          id: "ocgo-lite",
          order: 1,
          label: () => "OpenCode Go 用量",
        }, (props) => React.createElement(OcgoLite, { sessionId: props && props.sessionId }))
      ), "ocgo-lite: dock");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
