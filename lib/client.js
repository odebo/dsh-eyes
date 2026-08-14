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

		/* ── settings controller (external store) ────────────────────── */
		function EyesController() {
			this.state = { status: "idle" };
			this.listeners = new Set();
			this.generation = 0;
		}
		EyesController.prototype.subscribe = function (listener) {
			this.listeners.add(listener);
			var self = this;
			return function () { self.listeners.delete(listener); };
		};
		EyesController.prototype.snapshot = function () { return this.state; };
		EyesController.prototype.set = function (next) {
			this.state = next;
			this.listeners.forEach(function (f) { f(); });
		};
		EyesController.prototype.load = async function () {
			var gen = ++this.generation;
			this.set(Object.assign({}, this.state, { status: "loading", error: undefined, message: undefined }));
			try {
				var snapshot = await apiRequest();
				if (gen !== this.generation) return;
				this.set({ status: "ready", snapshot: snapshot, health: this.state.health });
			} catch (error) {
				if (gen !== this.generation) return;
				this.set(Object.assign({}, this.state, { status: "error", error: errMessage(error) }));
			}
		};
		EyesController.prototype.save = async function (value, expectedRevision) {
			this.set(Object.assign({}, this.state, { action: "save", error: undefined, message: undefined }));
			try {
				var snapshot = await apiRequest({
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action: "save", expectedRevision: expectedRevision, value: value }),
				});
				this.set({ status: "ready", snapshot: snapshot, health: this.state.health, message: "saved" });
			} catch (error) {
				this.set(Object.assign({}, this.state, { action: undefined, error: errMessage(error) }));
			}
		};
		EyesController.prototype.runHealth = async function (testConnection) {
			this.set(Object.assign({}, this.state, { action: testConnection ? "connection" : "health", error: undefined, message: undefined }));
			try {
				var health = await apiRequest({
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action: "health", testConnection: testConnection }),
				});
				this.set(Object.assign({}, this.state, { action: undefined, health: health }));
			} catch (error) {
				this.set(Object.assign({}, this.state, { action: undefined, error: errMessage(error) }));
			}
		};

		function errMessage(error) { return error instanceof Error ? error.message : String(error); }

		/* ── draft helpers (flatten nested config into editable fields) ─ */
		function draftOf(value) {
			var v = value || {};
			var up = v.upstream || {};
			var vi = v.vision || {};
			return {
				upstreamProvider: up.provider || "",
				upstreamModel: up.model || "",
				visionModel: vi.model || "",
				visionCredential: vi.credential || "",
				visionBaseURL: vi.baseURL || "",
				visionPrompt: vi.prompt || "",
				language: v.language || "zh",
			};
		}
		function valueOf(draft) {
			return {
				upstream: { provider: draft.upstreamProvider, model: draft.upstreamModel },
				vision: { model: draft.visionModel, credential: draft.visionCredential, baseURL: draft.visionBaseURL, prompt: draft.visionPrompt },
				language: draft.language,
			};
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
			var state = controller.snapshot();

			var draftState = React.useState(null);
			var draft = draftState[0], setDraft = draftState[1];
			var draftErrorState = React.useState(undefined);
			var draftError = draftErrorState[0], setDraftError = draftErrorState[1];

			React.useEffect(function () {
				if (state.status === "idle") void controller.load();
				var unsub = controller.subscribe(function () {
					/* force re-render via state read on next render */
				});
				return unsub;
			}, []);

			// re-render on controller changes
			var tickState = React.useState(0);
			React.useEffect(function () {
				return controller.subscribe(function () { tickState[1](function (n) { return n + 1; }); });
			}, []);

			if (state.status === "idle" || state.status === "loading") {
				return h("div", { className: "de-loading" }, "加载 dsh-eyes 设置…");
			}
			if (state.status === "error" && state.snapshot === undefined) {
				return h("div", { className: "de-alert error" }, "加载失败:" + (state.error || ""));
			}

			var snapshot = state.snapshot;
			var editable = draftOf(snapshot.settings.value);
			var current = draft === null ? editable : draft;
			function update(key, val) {
				var next = Object.assign({}, current);
				next[key] = val;
				setDraft(next);
				setDraftError(undefined);
			}
			function reset() { setDraft(null); setDraftError(undefined); }
			function save() {
				controller.save(valueOf(current), snapshot.settings.revision);
				setDraft(null);
			}

			var busy = state.action !== undefined;
			var credOk = snapshot.credential.configured;

			return h("div", { className: "de-settings" },
				h("header", { className: "de-header" },
					h("div", null,
						h("span", { className: "de-kicker" }, "DSH NATIVE PLUGIN"),
						h("h2", null, "dsh-eyes"),
						h("p", null, "视觉桥接:让纯文本 DeepSeek 模型通过多模态模型理解对话框里粘贴的图片,无需切换模型。"),
					),
					h("div", { className: "de-release" },
						h("span", null, "适配器 ", h("strong", null, snapshot.adapterRegistered ? "已注册" : "未注册")),
						h("span", null, "凭据 ", h("strong", null, credOk ? "已配置" : "缺失")),
					),
				),
				!snapshot.writable ? h("div", { className: "de-alert warning" }, "设置只读:更换活动的 Settings 提供方,或编辑其拥有的 Profile 配置。") : null,
				state.error ? h("div", { className: "de-alert error" }, state.error) : null,
				state.message === "saved" ? h("div", { className: "de-alert success" }, "已保存并应用(即时生效,无需重启)。") : null,
				/* 视觉服务 panel */
				h("section", { className: "de-panel" },
					h("div", { className: "de-panel-title" },
						h("h3", null, "视觉服务"),
						Badge({ ok: credOk }, credOk ? "已配置" : "缺失"),
					),
					h("div", { className: "de-form-grid" },
						Field({ label: "视觉模型", hint: "用于描述图片的多模态模型" },
							h("input", { value: current.visionModel, onChange: function (e) { update("visionModel", e.target.value); } }),
						),
						Field({ label: "Credential 引用", hint: snapshot.credential.source ? ("来源: " + snapshot.credential.source) : undefined },
							h("input", { value: current.visionCredential, onChange: function (e) { update("visionCredential", e.target.value); } }),
						),
						Field({ label: "服务地址", hint: "Anthropic 兼容 base URL" },
							h("input", { value: current.visionBaseURL, onChange: function (e) { update("visionBaseURL", e.target.value); } }),
						),
						Field({ label: "输出语言" },
							h("select", { value: current.language, onChange: function (e) { update("language", e.target.value); } },
								h("option", { value: "zh" }, "中文"),
								h("option", { value: "en" }, "English"),
							),
						),
						Field({ label: "描述提示词", hint: "随每张图片发送的 focus 提示词" },
							h("textarea", { rows: 2, value: current.visionPrompt, onChange: function (e) { update("visionPrompt", e.target.value); } }),
						),
					),
				),
				/* 主力模型 panel */
				h("section", { className: "de-panel" },
					h("div", { className: "de-panel-title" }, h("h3", null, "主力模型")),
					h("div", { className: "de-form-grid" },
						Field({ label: "Provider 路由", hint: "委派文本请求的真实 provider" },
							h("input", { value: current.upstreamProvider, onChange: function (e) { update("upstreamProvider", e.target.value); } }),
						),
						Field({ label: "文本模型", hint: "回答对话的文本模型" },
							h("input", { value: current.upstreamModel, onChange: function (e) { update("upstreamModel", e.target.value); } }),
						),
					),
				),
				/* save / reload */
				h("div", { className: "de-save-row" },
					h("button", { className: "de-btn primary", disabled: !snapshot.writable || busy, onClick: save }, state.action === "save" ? "保存中…" : "保存并应用"),
					h("button", { className: "de-btn outline", disabled: busy, onClick: function () { reset(); void controller.load(); } }, "重新加载"),
				),
				/* 健康检查 panel */
				h("section", { className: "de-panel" },
					h("div", { className: "de-panel-title" },
						h("div", null, h("h3", null, "健康检查"), h("p", null, "测试连接会把凭据发送到视觉端点的 GET /v1/models,不上传图片。")),
						h("div", { className: "de-actions" },
							h("button", { className: "de-btn sm outline", disabled: busy, onClick: function () { void controller.runHealth(false); } }, state.action === "health" ? "检测中…" : "运行健康检查"),
							h("button", { className: "de-btn sm primary", disabled: busy, onClick: function () { void controller.runHealth(true); } }, state.action === "connection" ? "测试中…" : "测试连接"),
						),
					),
					state.health === undefined
						? h("p", { className: "de-muted" }, "尚未检测。")
						: h("div", { className: "de-health-grid" },
							Object.entries(state.health.checks).map(function (entry) {
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
			".de-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}",
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
			ctx.effect(function () {
				var disposers = [
					ctx.on("settings/changed", function (namespace) { if (namespace === "dsh-eyes") controller.refreshIfLoaded && controller.load(); }),
					ctx.on("credentials/changed", function () { if (controller.state.status !== "idle") void controller.load(); }),
					ctx.on("connection/reset", function () { if (controller.state.status !== "idle") void controller.load(); }),
				];
				return function () { disposers.forEach(function (d) { d && d(); }); };
			}, "dsh-eyes: Settings invalidations");

			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "dsh-eyes",
					order: 31,
					label: function () { return "dsh-eyes"; },
					inject: function () { return { controller: controller }; },
				}, SettingsSection);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
