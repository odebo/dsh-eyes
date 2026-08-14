/* dsh-eyes — browser half (pre-bundled client plugin).
 *
 * Registers one Settings card (settings.section) that configures the dsh-eyes
 * vision bridge: vision model/credential/endpoint, upstream text model,
 * language, plus save/reload and a test-connection check. Talks to the host
 * half through the same-origin /_dsh/dsh-eyes/settings route.
 *
 * Hand-written in the shipped client-bundle format
 * (window.__ModuleLoader__.load + module.exports = { apply, inject }), no
 * build step — matches dsh-my-agents.
 */
window.__ModuleLoader__.load({
	id: "dsh-eyes",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;

		var SETTINGS_ROUTE = "/_dsh/dsh-eyes/settings";

		var inject = ["slots", "connection"];

		/* ── fetch wrapper ────────────────────────────────────────────── */
		async function apiRequest(init) {
			var response = await fetch(SETTINGS_ROUTE, Object.assign({ credentials: "same-origin" }, init || {}));
			var body = await response.json();
			if (!response.ok || !body.ok) {
				throw new Error((body.error && body.error.message) || ("dsh-eyes request failed with HTTP " + response.status));
			}
			return body.value;
		}

		/* ── settings controller (plain promise-returning API) ────────── */
		// No external store, no useSyncExternalStore: methods return their
		// result and the component holds state with useState — the same simple
		// shape as dsh-my-agents, which is the verified local-plugin pattern.
		function EyesController() {
			this.load = async () => apiRequest();
			this.save = async (value, expectedRevision) => apiRequest({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "save", expectedRevision: expectedRevision, value: value }),
			});
			this.runHealth = async (testConnection) => apiRequest({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "health", testConnection: testConnection }),
			});
		}

		function errMessage(error) { return error instanceof Error ? error.message : String(error); }

		/* ── draft helpers (视觉服务: baseURL / model / credential) ── */
		function draftOf(value) {
			var vi = (value && value.vision) || {};
			return {
				visionBaseURL: vi.baseURL || "",
				visionModel: vi.model || "",
				visionCredential: vi.credential || "",
			};
		}
		function valueOf(draft) {
			return { vision: { baseURL: draft.visionBaseURL, model: draft.visionModel, credential: draft.visionCredential } };
		}

		/* ── small presentational helpers ────────────────────────────── */
		function Field(props) {
			return h("label", { className: "de-field" },
				h("span", null, props.label),
				props.children,
				props.hint ? h("small", null, props.hint) : null,
			);
		}
		function Badge(props) {
			var ok = props.ok;
			return h("span", { className: "de-badge " + (ok ? "ok" : "error") }, props.children);
		}

		/* ── the Settings card ───────────────────────────────────────── */
		function SettingsSection(props) {
			var controller = props.controller;
			if (controller === undefined) return null;
			return h(LoadedSettings, { controller: controller });
		}

		function LoadedSettings(props) {
			var controller = props.controller;

			var draftState = useState(null);
			var draft = draftState[0], setDraft = draftState[1];
			var snapshotState = useState(null);
			var snapshot = snapshotState[0], setSnapshot = snapshotState[1];
			var errState = useState(null);
			var err = errState[0], setErr = errState[1];
			var savedState = useState(false);
			var saved = savedState[0], setSaved = savedState[1];
			var busyState = useState(false);
			var busy = busyState[0], setBusy = busyState[1];
			var healthState = useState(undefined);
			var health = healthState[0], setHealth = healthState[1];

			function reload() {
				setBusy(true);
				controller.load().then(function (snap) {
					setSnapshot(snap);
					setDraft(draftOf(snap.settings.value));
					setErr(null);
					setBusy(false);
				}).catch(function (e) { setErr(errMessage(e)); setBusy(false); });
			}
			useEffect(function () { reload(); }, []);

			if (snapshot === null && err === null) {
				return h("div", { className: "de-loading" }, "加载 DSH-Eyes 设置…");
			}
			if (snapshot === null) {
				return h("div", { className: "de-settings" },
					h("div", { className: "de-alert error" }, err || "设置不可用"),
					h("button", { className: "de-btn outline", onClick: reload }, "重试"),
				);
			}

			function update(key, val) {
				setDraft(function (cur) { return cur === null ? cur : Object.assign({}, cur, { [key]: val }); });
				setSaved(false);
			}
			function save() {
				setBusy(true);
				controller.save(valueOf(draft), snapshot.settings.revision).then(function (snap) {
					setSnapshot(snap);
					setDraft(draftOf(snap.settings.value));
					setSaved(true);
					setErr(null);
					setBusy(false);
				}).catch(function (e) { setErr(errMessage(e)); setBusy(false); });
			}
			function test() {
				setBusy(true);
				controller.runHealth(true).then(function (h) {
					setHealth(h);
					setErr(null);
					setBusy(false);
				}).catch(function (e) { setErr(errMessage(e)); setBusy(false); });
			}

			var credOk = snapshot.credential.configured;

			return h("div", { className: "de-settings" },
				h("header", { className: "de-header" },
					h("div", null,
						h("span", { className: "de-kicker" }, "DSH NATIVE PLUGIN"),
						h("h2", null, "DSH-Eyes"),
						h("p", null, "给纯文本 DeepSeek 模型补一个多模态视觉模型:对话框贴图时自动用它理解图片,无需切换模型。"),
					),
					h("div", { className: "de-release" },
						h("span", null, "桥接 ", h("strong", null, snapshot.adapterRegistered ? "已激活" : "未激活")),
						h("span", null, "密钥 ", h("strong", null, credOk ? "已配置" : "缺失")),
					),
				),
				!snapshot.writable ? h("div", { className: "de-alert warning" }, "设置只读。") : null,
				err ? h("div", { className: "de-alert error" }, err) : null,
				saved ? h("div", { className: "de-alert success" }, "已保存并应用(即时生效,无需重启)。") : null,
				/* 视觉服务 — mirroring the Vision Toolkit card */
				h("section", { className: "de-panel" },
					h("div", { className: "de-panel-title" },
						h("h3", null, "视觉服务"),
						h(Badge, { ok: credOk }, credOk ? "已配置" : "缺失"),
					),
					h("div", { className: "de-form-grid" },
						h(Field, { label: "服务地址", hint: "Anthropic 兼容 base URL" },
							h("input", { value: draft.visionBaseURL, onChange: function (e) { update("visionBaseURL", e.target.value); } }),
						),
						h(Field, { label: "模型", hint: "用于理解图片的多模态模型" },
							h("input", { value: draft.visionModel, onChange: function (e) { update("visionModel", e.target.value); } }),
						),
						h(Field, { label: "Credential 引用", hint: snapshot.credential.source ? ("来源: " + snapshot.credential.source) : "在「设置 → 模型」里配置该凭据" },
							h("input", { value: draft.visionCredential, onChange: function (e) { update("visionCredential", e.target.value); } }),
						),
					),
				),
				/* save / reload */
				h("div", { className: "de-save-row" },
					h("button", { className: "de-btn primary", disabled: !snapshot.writable || busy, onClick: save }, busy ? "保存中…" : "保存并应用"),
					h("button", { className: "de-btn outline", disabled: busy, onClick: reload }, "重新加载"),
				),
				/* 连接测试 */
				h("section", { className: "de-panel" },
					h("div", { className: "de-panel-title" },
						h("div", null, h("h3", null, "连接测试"), h("p", null, "发一张真实图片给视觉模型,验证它能否看图(不上传你的图片)。")),
						h("div", { className: "de-actions" },
							h("button", { className: "de-btn sm primary", disabled: busy, onClick: test }, "测试连接"),
						),
					),
					health === undefined
						? h("p", { className: "de-muted" }, "尚未检测。")
						: h("div", { className: "de-health-grid" },
							Object.entries(health.checks).map(function (entry) {
								var name = entry[0], check = entry[1];
								return h("div", { key: name, "data-status": check.status },
									h("span", null, name),
									h("strong", null, check.status),
									h("p", null, check.detail),
								);
							}),
						),
				),
			);
		}

		/* ── styles (one style element, scoped via .de- prefix) ──────── */
		var STYLE = [
			".de-settings{display:grid;gap:14px;max-width:900px;padding:8px 2px 32px;color:var(--dsw-alias-fg-primary,#26231f)}",
			".de-header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding:8px 2px}",
			".de-header h2{font-size:25px;letter-spacing:-.025em;margin:3px 0 6px}",
			".de-header p{max-width:620px;margin:0;color:var(--dsw-alias-fg-muted,#77736d);font-size:13px;line-height:1.55}",
			".de-kicker{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#6758d4;font-weight:700}",
			".de-release{display:grid;gap:4px;min-width:170px;padding:9px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);font-size:10px;color:var(--dsw-alias-fg-muted,#77736d)}",
			".de-release span{display:flex;justify-content:space-between;gap:12px}.de-release strong{color:var(--dsw-alias-fg-primary,#26231f)}",
			".de-alert{padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.5}.de-alert.warning{background:rgba(224,162,55,.12);color:#986818}.de-alert.error{background:rgba(205,72,72,.1);color:#aa3939}.de-alert.success{background:rgba(48,154,100,.1);color:#267d52}",
			".de-panel{display:grid;gap:12px;padding:15px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 1px rgba(0,0,0,.02)}",
			".de-panel-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.de-panel-title h3{font-size:14px;margin:0}.de-panel-title p{font-size:11px;line-height:1.45;color:var(--dsw-alias-fg-muted,#77736d);margin:4px 0 0;max-width:620px}",
			".de-badge{font-size:10px;padding:3px 7px;border-radius:999px;font-weight:650}.de-badge.ok{background:rgba(48,154,100,.12);color:#267d52}.de-badge.error{background:rgba(205,72,72,.1);color:#aa3939}",
			".de-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.de-form-one{grid-template-columns:1fr}",
			".de-field{display:grid;gap:6px;align-content:start}.de-field>span{font-size:11px;font-weight:600}.de-field>small{font-size:10px;color:var(--dsw-alias-fg-muted,#77736d);line-height:1.4}",
			".de-field input,.de-field select,.de-field textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-subtle,#d9d5ce);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px;padding:8px 10px}",
			".de-field select{height:36px}.de-field textarea{resize:vertical;min-height:56px}",
			".de-save-row{display:flex;gap:8px;padding:2px 0}",
			".de-btn{cursor:pointer;border-radius:9px;font:inherit;font-size:12px;padding:8px 14px;border:1px solid var(--dsw-alias-border-subtle,#d9d5ce);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit}",
			".de-btn.primary{background:#6758d4;border-color:#6758d4;color:#fff}.de-btn.outline{background:transparent}.de-btn.sm{font-size:11px;padding:6px 10px}.de-btn:disabled{opacity:.55;cursor:not-allowed}",
			".de-actions{display:flex;gap:8px}",
			".de-health-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}.de-health-grid>div{padding:9px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);border-left:3px solid #aaa}",
			".de-health-grid>div[data-status=ok]{border-left-color:#39a66b}.de-health-grid>div[data-status=error]{border-left-color:#cf5050}",
			".de-health-grid span{font-size:10px;text-transform:capitalize}.de-health-grid strong{float:right;font-size:9px;text-transform:uppercase;color:var(--dsw-alias-fg-muted,#77736d)}.de-health-grid p{clear:both;margin:5px 0 0;font-size:10px;line-height:1.4;color:var(--dsw-alias-fg-muted,#77736d)}",
			".de-loading{padding:24px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);font-size:12px;color:var(--dsw-alias-fg-muted,#77736d)}",
			".de-muted{margin:0;color:var(--dsw-alias-fg-muted,#77736d);font-size:12px}",
			"@media(max-width:720px){.de-header{display:grid}.de-release{width:auto}.de-form-grid{grid-template-columns:1fr}}",
		].join("\n");

		function apply(ctx) {
			ctx.effect(function () {
				var style = document.createElement("style");
				style.textContent = STYLE;
				document.head.appendChild(style);
				return function () { document.head.removeChild(style); };
			}, "dsh-eyes: styles");

			var controller = new EyesController();

			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "dsh-eyes",
					order: 31,
					label: function () { return "DSH-Eyes"; },
					inject: function () { return { controller: controller }; },
				}, SettingsSection);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
