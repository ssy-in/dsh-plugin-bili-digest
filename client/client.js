window.__ModuleLoader__.load({
	id: "dsh-plugin-bili-digest",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");
		var h = react.createElement;

		var API = "/bili-digest/api";
		var NS = "bili-digest";

		/** 所有请求都同源、都带 JSON 头；写操作额外带 x-bili-digest 让跨站表单请求失效。 */
		function call(path, body) {
			var init = { credentials: "same-origin", headers: { accept: "application/json" } };
			if (body === undefined) {
				init.method = "GET";
			} else {
				init.method = "POST";
				init.headers["content-type"] = "application/json";
				init.headers["x-bili-digest"] = "1";
				init.body = JSON.stringify(body);
			}
			return fetch(new URL(path.replace(/^\/+/, ""), document.baseURI).pathname, init).then(async function (response) {
				var text = await response.text();
				var value;
				try {
					value = JSON.parse(text);
				} catch (error) {
					throw new Error("服务端返回了非 JSON 内容（HTTP " + response.status + "）");
				}
				if (!response.ok || value.ok === false) throw new Error(value.error || "HTTP " + response.status);
				return value;
			});
		}

		var COLORS = {
			line: "var(--dsh-border-color, rgba(127,127,127,0.28))",
			muted: "var(--dsh-text-color-secondary, rgba(127,127,127,0.95))",
			accent: "var(--dsh-accent-color, #3b82f6)",
			danger: "var(--dsh-danger-color, #dc2626)",
		};

		var box = (extra) =>
			Object.assign(
				{
					border: "1px solid " + COLORS.line,
					borderRadius: 10,
					padding: "12px 14px",
					marginBottom: 10,
					background: "transparent",
				},
				extra || {},
			);

		var inputStyle = {
			width: "100%",
			padding: "6px 8px",
			borderRadius: 8,
			border: "1px solid " + COLORS.line,
			background: "transparent",
			color: "inherit",
			font: "inherit",
			boxSizing: "border-box",
		};

		var buttonStyle = (primary) => ({
			padding: "6px 14px",
			borderRadius: 8,
			border: "1px solid " + (primary ? "transparent" : COLORS.line),
			background: primary ? COLORS.accent : "transparent",
			color: primary ? "#fff" : "inherit",
			cursor: "pointer",
			font: "inherit",
		});

		function Field(props) {
			return h(
				"label",
				{ style: { display: "block", marginBottom: 8 } },
				h("span", { style: { display: "block", fontSize: 12, color: COLORS.muted, marginBottom: 4 } }, props.label),
				props.children,
			);
		}

		function stamp(seconds) {
			var total = Math.max(0, Math.floor(Number(seconds) || 0));
			return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
		}

		function SegmentList(props) {
			var open = react.useState(false);
			var expanded = open[0];
			var setExpanded = open[1];
			var cues = props.cues;
			var text = react.useState(null);
			var cueText = text[0];
			var setCueText = text[1];
			var bvid = props.bvid;
			var from = cues.length ? cues[0].from : 0;
			var to = cues.length ? cues[cues.length - 1].to : 0;
			var load = function () {
				if (cueText) {
					setExpanded(!expanded);
					return;
				}
				call(API + "/recall", { bvid: bvid, from: Math.floor(from), to: Math.ceil(to) })
					.then((value) => setCueText(value.cues.map((cue) => "[" + cue.t + "] " + cue.text).join("\n")))
					.catch((error) => setCueText("回查失败：" + error.message));
				setExpanded(true);
			};
			return h(
				"div",
				null,
				h(
					"button",
					{ style: buttonStyle(false), onClick: load },
					expanded ? "收起原文" : "展开原文（" + cues.length + " 段）",
				),
				expanded &&
					h(
						"pre",
						{
							style: {
								whiteSpace: "pre-wrap",
								wordBreak: "break-word",
								fontSize: 12,
								lineHeight: 1.6,
								marginTop: 8,
								maxHeight: 320,
								overflow: "auto",
							},
						},
						cueText || "加载中…",
					),
			);
		}

		function Frames(props) {
			var state = react.useState({ loading: false, error: "", times: null });
			var snap = state[0];
			var setSnap = state[1];
			var bvid = props.bvid;
			var count = props.count || 0;
			var load = function () {
				if (snap.times) {
					setSnap({ loading: false, error: "", times: null });
					return;
				}
				setSnap({ loading: true, error: "", times: null });
				call(API + "/frames", { bvid: bvid, count: count })
					.then((value) => setSnap({ loading: false, error: "", times: value.times }))
					.catch((error) => setSnap({ loading: false, error: error.message, times: null }));
			};
			return h(
				"div",
				{ style: { marginTop: 8 } },
				h("button", { style: buttonStyle(false), onClick: load }, snap.times ? "收起画面" : "看画面" + (props.label ? "（" + props.label + "）" : "")),
				snap.loading && h("div", { style: { fontSize: 12, color: COLORS.muted, marginTop: 6 } }, "抓帧中…（首次要下载并解码 B 站分镜图）"),
				snap.error && h("div", { style: { fontSize: 12, color: COLORS.danger, marginTop: 6 } }, "抓帧失败：" + snap.error),
				snap.times &&
					h(
						"div",
						{ style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8, marginTop: 8 } },
						snap.times.map((second) =>
							h(
								"a",
								{
									key: second,
									href: "https://www.bilibili.com/video/" + bvid + "?t=" + second,
									target: "_blank",
									rel: "noreferrer noopener",
									style: { display: "block", color: "inherit", textDecoration: "none" },
								},
								h("img", {
									src: API + "/frame?bvid=" + encodeURIComponent(bvid) + "&t=" + second,
									alt: stamp(second),
									loading: "lazy",
									style: { width: "100%", display: "block", borderRadius: 6, border: "1px solid " + COLORS.line },
								}),
								h("div", { style: { fontSize: 11, color: COLORS.muted, marginTop: 2 } }, stamp(second)),
							),
						),
					),
			);
		}

		function Section(props) {
			var section = props.section;
			return h(
				"li",
				{ style: box() },
				h(
					"div",
					{ style: { fontWeight: 600, marginBottom: 4 } },
					h(
						"a",
						{
							href: "https://www.bilibili.com/video/" + section.bvid,
							target: "_blank",
							rel: "noreferrer noopener",
							style: { color: "inherit" },
						},
						section.title,
					),
				),
				h(
					"div",
					{ style: { fontSize: 12, color: COLORS.muted, marginBottom: 8 } },
					"UP " + section.up + " ｜ " + stamp(section.duration) + " ｜ 字幕 " + section.chars + " 字 ｜ " + section.picked.length + " 段",
				),
				h(
					"ul",
					{ style: { margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 } },
					section.picked.map((segment) =>
						h(
							"li",
							{ key: segment.from },
							h(
								"a",
								{
									href: "https://www.bilibili.com/video/" + section.bvid + "?t=" + Math.floor(segment.from),
									target: "_blank",
									rel: "noreferrer noopener",
									style: { color: COLORS.accent, marginRight: 6 },
								},
								stamp(segment.from),
							),
							segment.text,
						),
					),
				),
				h("div", { style: { marginTop: 8 } }, h(SegmentList, { bvid: section.bvid, cues: section.picked })),
				h(Frames, { bvid: section.bvid, label: "核对画面" }),
				h(PushButton, { bvid: section.bvid, title: section.title }),
			);
		}

		// 一条视频的「收藏 + @ 大号」按钮：点了才发，每天最多 3 条（服务端会拦）。
		function PushButton(props) {
			var pushState = react.useState({ busy: false, text: "", ok: false });
			var info = pushState[0];
			var setInfo = pushState[1];
			var send = function () {
				if (info.busy) return;
				setInfo({ busy: true, text: "", ok: false });
				call("/push", { bvid: props.bvid })
					.then(function (payload) {
						if (payload && payload.ok) {
							var left = payload.left === undefined ? "" : "（今天还能 @ " + payload.left + " 条）";
							setInfo({ busy: false, ok: true, text: "已收藏到「" + ((payload.folders || {})[payload.role] || {}).title + "」" + (payload.comment ? "，并在视频下 @ 了人类" : "，没发评论（缺昵称/UID）") + left });
						} else {
							setInfo({ busy: false, ok: false, text: "没有推：" + ((payload && (payload.skipped || payload.error)) || "未知原因") });
						}
					})
					.catch(function (error) {
						setInfo({ busy: false, ok: false, text: String(error && error.message ? error.message : error) });
					});
			};
			return h(
				"div",
				{ style: { marginTop: 6 } },
				h(
					"button",
					{
						onClick: send,
						disabled: info.busy,
						style: {
							background: info.busy ? COLORS.border : COLORS.accent,
							color: "#fff",
							border: "none",
							borderRadius: 6,
							padding: "4px 10px",
							fontSize: 12,
							cursor: info.busy ? "default" : "pointer",
							marginRight: 8,
						},
					},
					info.busy ? "发送中…" : "收藏并 @ 我",
				),
				info.text && h("span", { style: { fontSize: 12, color: info.ok ? COLORS.muted : "#ff8a8a" } }, info.text),
			);
		}

		function Panel(props) {
			var state = react.useState({ loading: true, error: "", data: null });
			var snapshot = state[0];
			var setSnapshot = state[1];
			var jobState = react.useState(null);
			var job = jobState[0];
			var setJob = jobState[1];
			var formState = react.useState({
				keywords: "deepseek",
				days: "7",
				limit: "12",
				k: "",
				minCharsPerMinute: "60",
				frameCount: "0",
				autoFrames: true,
				minDuration: "180",
				shortVideoMax: "300",
				maxVideos: "1",
				ownFavoritePerDay: "3",
				autoEveryMinutes: "0",
				scheduleEnabled: true,
				activeFrom: "08:00",
				activeTo: "01:30",
				autoMoodText: "随便看看",
				autoKeywords: "",
				autoOrder: "pubdate",
				autoDays: "7",
				explorePerWeek: "2",
				pushEnabled: false,
				atName: "",
				atMid: "",
				outputDir: "",
		replyEnabled: false,
				sessdata: "",
				moodText: "",
				moodPreset: "",
			});
			var form = formState[0];
			var setForm = formState[1];
			var diaryState = react.useState({ loading: false, text: "", path: "", error: "" });
			var diary = diaryState[0];
			var setDiary = diaryState[1];
			var notice = react.useState("");
			var setNotice = notice[1];
			var hydrated = react.useState(false);
			var isHydrated = hydrated[0];
			var setHydrated = hydrated[1];

			var refresh = function () {
				return call(API + "/state")
					.then((data) => {
						setSnapshot({ loading: false, error: "", data: data });
						if (!isHydrated && data.settings) {
							setForm((current) =>
								Object.assign({}, current, {
									days: String(data.settings.days === undefined ? current.days : data.settings.days),
									limit: String(data.settings.limit === undefined ? current.limit : data.settings.limit),
									minCharsPerMinute: String(data.settings.minCharsPerMinute === undefined ? current.minCharsPerMinute : data.settings.minCharsPerMinute),
									frameCount: String(data.settings.frameCount === undefined ? current.frameCount : data.settings.frameCount),
									minDuration: String(data.settings.minDuration === undefined ? current.minDuration : data.settings.minDuration),
									shortVideoMax: String(data.settings.shortVideoMax === undefined ? current.shortVideoMax : data.settings.shortVideoMax),
									maxVideos: String(data.settings.maxVideos === undefined ? current.maxVideos : data.settings.maxVideos),
									ownFavoritePerDay: String(data.settings.ownFavoritePerDay === undefined ? current.ownFavoritePerDay : data.settings.ownFavoritePerDay),
									autoEveryMinutes: String(data.settings.autoEveryMinutes === undefined ? current.autoEveryMinutes : data.settings.autoEveryMinutes),
									scheduleEnabled: data.settings.scheduleEnabled !== false,
									activeFrom: String(data.settings.activeFrom === undefined ? current.activeFrom : data.settings.activeFrom),
									activeTo: String(data.settings.activeTo === undefined ? current.activeTo : data.settings.activeTo),
									autoMoodText: String(data.settings.autoMoodText === undefined ? current.autoMoodText : data.settings.autoMoodText),
									autoKeywords: String(data.settings.autoKeywords === undefined ? current.autoKeywords : data.settings.autoKeywords),
									autoOrder: String(data.settings.autoOrder === undefined ? current.autoOrder : data.settings.autoOrder),
									autoDays: String(data.settings.autoDays === undefined ? current.autoDays : data.settings.autoDays),
									explorePerWeek: String(data.settings.explorePerWeek === undefined ? current.explorePerWeek : data.settings.explorePerWeek),
									pushEnabled: data.settings.pushEnabled === true,
			replyEnabled: data.settings.replyEnabled === true,
									atName: String(data.settings.atName === undefined ? current.atName : data.settings.atName),
									atMid: String(data.settings.atMid === undefined ? current.atMid : data.settings.atMid),
									outputDir: String(data.settings.outputDir === undefined ? current.outputDir : data.settings.outputDir),
									autoFrames: data.settings.autoFrames !== false,
								}),
							);
							setHydrated(true);
						}
					})
					.catch((error) => setSnapshot({ loading: false, error: error.message, data: null }));
			};

			react.useEffect(() => {
				refresh();
			}, []);

			react.useEffect(() => {
				if (!job || job.status !== "running") return undefined;
				var timer = setInterval(() => {
					call(API + "/job")
						.then((value) => {
							setJob(value.job);
							if (value.job.status !== "running") {
								refresh();
								setNotice(value.job.status === "done" ? "本轮完成" : "本轮失败：" + value.job.error);
							}
						})
						.catch((error) => setNotice("进度获取失败：" + error.message));
				}, 900);
				return () => clearInterval(timer);
			}, [job && job.id, job && job.status]);

			if (props.view === "summary") {
				return h(
					"span",
					null,
					"字幕优先的 B 站阅读器：有字幕的只把关键段落交给模型，没有字幕的直接跳过、改用分镜截图看画面。",
				);
			}

			var settings = snapshot.data ? snapshot.data.settings : {};
			var login = snapshot.data ? snapshot.data.login : {};
			var last = snapshot.data ? snapshot.data.last : null;

			var start = function () {
				setNotice("");
				var keywords = form.keywords
					.split(/[,，\s]+/)
					.map((word) => word.trim())
					.filter(Boolean);
				if (!keywords.length) {
					setNotice("先填关键词");
					return;
				}
				var body = { keywords: keywords, days: Number(form.days) || 0, limit: Number(form.limit) || 12 };
				if (form.k && Number(form.k) > 0) body.k = Number(form.k);
				if (form.minCharsPerMinute) body.minCharsPerMinute = Number(form.minCharsPerMinute);
				call(API + "/run", body)
					.then((value) => {
						setJob({ id: value.id, status: "running", progress: null });
						setNotice("已开始一轮");
					})
					.catch((error) => setNotice("启动失败：" + error.message));
			};

			var save = function () {				var body = {
					days: Number(form.days) || 0,
					limit: Number(form.limit) || 12,
					minCharsPerMinute: Number(form.minCharsPerMinute) || 60,
					frameCount: Number(form.frameCount) || 0,
					minDuration: Number(form.minDuration) || 0,
					shortVideoMax: Number(form.shortVideoMax) || 0,
					maxVideos: Number(form.maxVideos) || 0,
					ownFavoritePerDay: Number(form.ownFavoritePerDay) || 0,
					autoEveryMinutes: Number(form.autoEveryMinutes) || 0,
					scheduleEnabled: form.scheduleEnabled !== false,
					activeFrom: String(form.activeFrom || "08:00"),
					activeTo: String(form.activeTo || "01:30"),
					autoMoodText: String(form.autoMoodText || ""),
					autoKeywords: String(form.autoKeywords || ""),
					autoOrder: String(form.autoOrder || "pubdate"),
					autoDays: Number(form.autoDays) || 0,
					explorePerWeek: Number(form.explorePerWeek) || 0,
					pushEnabled: form.pushEnabled === true,
		replyEnabled: form.replyEnabled === true,
					atName: String(form.atName || ""),
					atMid: String(form.atMid || ""),
					outputDir: String(form.outputDir || ""),
					autoFrames: form.autoFrames !== false,
				};
				if (form.k && Number(form.k) > 0) body.maxK = Number(form.k);
				if (form.sessdata) body.sessdata = form.sessdata;
				call(API + "/settings", body)
					.then(() => {
						setForm(Object.assign({}, form, { sessdata: "" }));
						setNotice("已保存");
						return refresh();
					})
					.catch((error) => setNotice("保存失败：" + error.message));
			};

			var startMood = function () {
				setNotice("");
				var text = String(form.moodText || "").trim();
				var preset = String(form.moodPreset || "").trim();
				if (!text && !preset) {
					setNotice("写一句心情，或选一个档位");
					return;
				}
				var body = { days: Number(form.days) || 0, limit: Number(form.limit) || 12 };
				if (text) body.mood = text;
				if (preset) body.preset = preset;
				if (form.minDuration) body.minDuration = Number(form.minDuration);
				if (form.maxVideos !== "") body.videos = Number(form.maxVideos) || 0;
				call(API + "/mood", body)
					.then((value) => {
						setJob({ id: value.id, status: "running", progress: null, mode: "mood" });
						setNotice("按心情刷一轮…");
					})
					.catch((error) => setNotice("启动失败：" + error.message));
			};

			var openDiary = function () {
				setDiary({ loading: true, text: "", path: "", error: "" });
				call(API + "/diary")
					.then((value) => setDiary({ loading: false, text: value.text, path: value.path, error: "" }))
					.catch((error) => setDiary({ loading: false, text: "", path: "", error: error.message }));
			};

			var progress = job && job.progress;
			var progressText = progress
				? progress.phase === "gate"
					? "检查第 " + progress.index + "/" + progress.total + " 条：" + progress.bvid + " → " + progress.verdict + (progress.cached ? "（缓存）" : "")
					: "搜索「" + progress.keyword + "」→ " + progress.found + " 条"
				: "准备中…";
			var result = job && job.result;

			return h(
				"div",
				{ style: { font: "inherit" } },
				!snapshot.data &&
					!snapshot.error &&
					h("div", { style: { color: COLORS.muted } }, "读取状态…"),
				snapshot.error &&
					h("div", { style: box({ borderColor: COLORS.danger, color: COLORS.danger }) }, "读取失败：" + snapshot.error),
				snapshot.data &&
					h(
						"div",
						{ style: box({ background: "rgba(127,127,127,0.06)" }) },
						h(
							"div",
							{ style: { fontSize: 13 } },
							login.isLogin
								? "登录态正常：" + login.uname + "（mid " + login.mid + "）"
								: login.configured
									? "SESSDATA 已配置但不可用" + (login.error ? "：" + login.error : "")
									: "未配置 SESSDATA：匿名态拿不到字幕清单，先填下面这一项",
						),
						h("div", { style: { fontSize: 12, color: COLORS.muted, marginTop: 4 } }, "配置：" + (settings.configFile || "-")),
						h("div", { style: { fontSize: 12, color: COLORS.muted, marginTop: 4 } }, "我看视频（日记/速览/截图）：" + (snapshot.data.outDir || "-")),
						snapshot.data.auto &&
							h(
								"div",
								{ style: { fontSize: 12, color: COLORS.muted, marginTop: 4 } },
								snapshot.data.auto.everyMinutes > 0
									? "自动刷：每 " +
											snapshot.data.auto.everyMinutes +
											" 分钟一条（" +
											(snapshot.data.auto.keywords ? "关键词「" + snapshot.data.auto.keywords + "」" : "心情「" + snapshot.data.auto.moodText + "」") +
											(snapshot.data.auto.schedule
												? "｜" + snapshot.data.auto.schedule.label + "，下一次 " + snapshot.data.auto.schedule.nextAtLocal
												: "｜固定间隔（没开作息）") +
											"，已跑 " +
											snapshot.data.auto.runs +
											" 次" +
											(snapshot.data.auto.lastAutoAt ? "，上次 " + String(snapshot.data.auto.lastAutoAt).replace("T", " ").slice(0, 16) : "") +
											(snapshot.data.auto.error ? "，上次失败：" + snapshot.data.auto.error : "") +
											"）"
									: "自动刷：关（把「自动刷间隔」填 60 就是每小时一条）",
							),
						snapshot.data.own &&
							h(
								"div",
								{ style: { fontSize: 12, color: COLORS.muted, marginTop: 4 } },
								"鲸鲸自己收藏的：今天收了 " +
									snapshot.data.own.keptToday +
									" 条" +
									(snapshot.data.own.perDay > 0 ? "（上限 " + snapshot.data.own.perDay + "，还剩 " + snapshot.data.own.left + "）" : "（不限）") +
									"｜口味线 " +
									snapshot.data.own.bar.toFixed(2) +
									(snapshot.data.own.learnOnCollect ? "｜收藏才记口味" : "｜关掉了收藏记口味"),
							),
						snapshot.data.tagBook &&
							snapshot.data.tagBook.exploring &&
							snapshot.data.tagBook.exploring.topics &&
							snapshot.data.tagBook.exploring.topics.length > 0 &&
							h(
								"div",
								{ style: { fontSize: 12, color: COLORS.muted, marginTop: 4 } },
								"这周在试：" +
									snapshot.data.tagBook.exploring.topics.join("、") +
									"（" +
									snapshot.data.tagBook.exploring.week +
									"）｜不喜欢就在评论里说「少看点这类」",
							),
						last &&
							h(
								"div",
								{ style: { fontSize: 12, color: COLORS.muted, marginTop: 4 } },
								"上次：" +
									String(last.at || "").replace("T", " ").slice(0, 19) +
									" ｜ 候选 " +
									last.stats.candidates +
									" ｜ 可读 " +
									last.stats.readable +
									" ｜ 丢弃 " +
									last.stats.dropped +
									" ｜ 省 " +
									last.stats.saved +
									"%",
							),
					),

				snapshot.data &&
					h(
						"div",
						{ style: box() },
						h("div", { style: { fontSize: 13, marginBottom: 8 } }, "按心情刷一轮"),
					h(
						"div",
						{ style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 } },
						(snapshot.data.moodPresets || []).map((preset) =>
							h(
								"button",
								{
									key: preset.id,
									style: buttonStyle(form.moodPreset === preset.id),
									title: (preset.keywords || []).join("、"),
									onClick: () =>
										setForm(Object.assign({}, form, { moodPreset: form.moodPreset === preset.id ? "" : preset.id })),
								},
								preset.label,
							),
						),
					),
					h("textarea", {
						style: Object.assign({}, inputStyle, { height: 56, resize: "vertical", font: "inherit" }),
						placeholder: "比如：今天有点累，就想看点轻松的，别太费脑子",
						value: form.moodText,
						onChange: (event) => setForm(Object.assign({}, form, { moodText: event.target.value })),
					}),
					h(
						"div",
						{ style: { display: "flex", gap: 8, alignItems: "center", marginTop: 8 } },
						h("button", { style: buttonStyle(true), onClick: startMood, disabled: job && job.status === "running" }, "按心情刷一轮"),
						h("button", { style: buttonStyle(false), onClick: openDiary }, "看最新日记"),
						diary.loading && h("span", { style: { fontSize: 12, color: COLORS.muted } }, "读取日记…"),
						diary.error && h("span", { style: { fontSize: 12, color: COLORS.danger } }, "没有可读的日记：" + diary.error),
					),
					diary.text &&
						h(
							"div",
							{ style: { marginTop: 8 } },
							h("div", { style: { fontSize: 12, color: COLORS.muted, marginBottom: 4 } }, diary.path),
							h(
								"pre",
								{
									style: {
										fontSize: 12,
										maxHeight: 260,
										overflow: "auto",
										whiteSpace: "pre-wrap",
										padding: 8,
										margin: 0,
										background: "rgba(127,127,127,0.08)",
										borderRadius: 6,
									},
								},
								diary.text,
							),
						),
				),

				h(
					"div",
					{ style: box() },
					h(Field, { label: "关键词（逗号或空格分隔）" }, h("input", {
						style: inputStyle,
						value: form.keywords,
						onChange: (event) => setForm(Object.assign({}, form, { keywords: event.target.value })),
					})),
					h(
						"div",
						{ style: { display: "grid", gridTemplateColumns: "repeat(6, minmax(0,1fr))", gap: 8 } },
						h(Field, { label: "最近 N 天" }, h("input", {
							style: inputStyle,
							value: form.days,
							onChange: (event) => setForm(Object.assign({}, form, { days: event.target.value })),
						})),
						h(Field, { label: "候选条数" }, h("input", {
							style: inputStyle,
							value: form.limit,
							onChange: (event) => setForm(Object.assign({}, form, { limit: event.target.value })),
						})),
						h(Field, { label: "每条选几段" }, h("input", {
							style: inputStyle,
							placeholder: "自动",
							value: form.k,
							onChange: (event) => setForm(Object.assign({}, form, { k: event.target.value })),
						})),
						h(Field, { label: "字/分钟门槛" }, h("input", {
							style: inputStyle,
							value: form.minCharsPerMinute,
							onChange: (event) => setForm(Object.assign({}, form, { minCharsPerMinute: event.target.value })),
						})),
						h(Field, { label: "抓帧数（0=自动）" }, h("input", {
							style: inputStyle,
							value: form.frameCount,
							onChange: (event) => setForm(Object.assign({}, form, { frameCount: event.target.value })),
						})),
						h(Field, { label: "最短时长（秒）" }, h("input", {
							style: inputStyle,
							value: form.minDuration,
							onChange: (event) => setForm(Object.assign({}, form, { minDuration: event.target.value })),
						})),
						h(Field, { label: "短视频上限（秒，0=关）" }, h("input", {
							style: inputStyle,
							value: form.shortVideoMax,
							onChange: (event) => setForm(Object.assign({}, form, { shortVideoMax: event.target.value })),
						})),
						h(Field, { label: "一轮读几条" }, h("input", {
							style: inputStyle,
							value: form.maxVideos,
							onChange: (event) => setForm(Object.assign({}, form, { maxVideos: event.target.value })),
						})),
						h(Field, { label: "一天最多收几条（0=不限）" }, h("input", {
							style: inputStyle,
							value: form.ownFavoritePerDay,
							onChange: (event) => setForm(Object.assign({}, form, { ownFavoritePerDay: event.target.value })),
						})),
						h(Field, { label: "自动刷间隔（分钟，0=关）" }, h("input", {
							style: inputStyle,
							value: form.autoEveryMinutes,
							onChange: (event) => setForm(Object.assign({}, form, { autoEveryMinutes: event.target.value })),
						})),
						h(Field, { label: "按作息（睡觉时不刷、饭点更勤）" }, h("input", {
							type: "checkbox",
							checked: form.scheduleEnabled !== false,
							onChange: (event) => setForm(Object.assign({}, form, { scheduleEnabled: event.target.checked })),
						})),
						h(Field, { label: "起床时间" }, h("input", {
							style: inputStyle,
							placeholder: "08:00",
							value: form.activeFrom,
							onChange: (event) => setForm(Object.assign({}, form, { activeFrom: event.target.value })),
						})),
						h(Field, { label: "睡觉时间" }, h("input", {
							style: inputStyle,
							placeholder: "01:30",
							value: form.activeTo,
							onChange: (event) => setForm(Object.assign({}, form, { activeTo: event.target.value })),
						})),
						h(Field, { label: "自动刷时的心情" }, h("input", {
							style: inputStyle,
							placeholder: "随便看看",
							value: form.autoMoodText,
							onChange: (event) => setForm(Object.assign({}, form, { autoMoodText: event.target.value })),
						})),
						h(Field, { label: "自动刷关键词（填了就不看心情）" }, h("input", {
							style: inputStyle,
							placeholder: "deepseek",
							value: form.autoKeywords,
							onChange: (event) => setForm(Object.assign({}, form, { autoKeywords: event.target.value })),
						})),
						h(Field, { label: "自动刷排序" }, h("select", {
							style: inputStyle,
							value: form.autoOrder,
							onChange: (event) => setForm(Object.assign({}, form, { autoOrder: event.target.value })),
						}, ["pubdate", "totalrank", "click", "dm", "stow", "scores"].map((order) =>
							h("option", { key: order, value: order }, order === "pubdate" ? "pubdate（最新）" : order),
						))),
						h(Field, { label: "自动刷只看最近几天（0=不限）" }, h("input", {
							style: inputStyle,
							value: form.autoDays,
							onChange: (event) => setForm(Object.assign({}, form, { autoDays: event.target.value })),
						})),
						h(Field, { label: "一周试几个没见过的题材（0=不试）" }, h("input", {
							style: inputStyle,
							value: form.explorePerWeek,
							onChange: (event) => setForm(Object.assign({}, form, { explorePerWeek: event.target.value })),
						})),
						h(Field, { label: "看完 @ 谁（昵称）" }, h("input", {
							style: inputStyle,
							placeholder: "大号的昵称",
							value: form.atName,
							onChange: (event) => setForm(Object.assign({}, form, { atName: event.target.value })),
						})),
						h(Field, { label: "@ 的 UID" }, h("input", {
							style: inputStyle,
							placeholder: "大号的 mid",
							value: form.atMid,
							onChange: (event) => setForm(Object.assign({}, form, { atMid: event.target.value })),
						})),
						h(Field, { label: "输出目录（空=默认「我看视频」）" }, h("input", {
							style: inputStyle,
							placeholder: (snapshot.data && snapshot.data.outDir) || "",
							value: form.outputDir,
							onChange: (event) => setForm(Object.assign({}, form, { outputDir: event.target.value })),
						})),
					),
					h(
						"label",
						{ style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: COLORS.muted, marginBottom: 10 } },
						h("input", {
							type: "checkbox",
							checked: form.autoFrames,
							onChange: (event) => setForm(Object.assign({}, form, { autoFrames: event.target.checked })),
						}),
						"没有字幕的视频自动改用分镜截图（每帧约 170 token）",
					),
					h(
						"label",
						{ style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: COLORS.muted, marginBottom: 10 } },
						h("input", {
							type: "checkbox",
							checked: form.pushEnabled,
							onChange: (event) => setForm(Object.assign({}, form, { pushEnabled: event.target.checked })),
						}),
						"读完收藏到对应收藏夹，并在视频下 @ 我（每天最多 3 条）",
					),
					h(
						"label",
						{ style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: COLORS.muted, marginBottom: 10 } },
						h("input", {
							type: "checkbox",
							checked: form.replyEnabled,
							onChange: (event) => setForm(Object.assign({}, form, { replyEnabled: event.target.checked })),
						}),
						"有人回复我就回一句（每人 1 次，≤10 次/小时，≤50 次/天）",
					),
					snapshot.data &&
						snapshot.data.inbox &&
						h(
							"div",
							{ style: { fontSize: 12, color: COLORS.muted, marginBottom: 10 } },
							`消息：今天已回 ${snapshot.data.inbox.repliedToday} 条，还能回 ${snapshot.data.inbox.dayLeft} 条（这一小时还能回 ${snapshot.data.inbox.hourLeft} 条）`,
						),
					h(Field, { label: "SESSDATA（只写不读，存到 0600 私有文件）" }, h("input", {
						style: inputStyle,
						type: "password",
						autoComplete: "off",
						placeholder: login.configured ? "（已配置，留空则不改）" : "B 站网页 Cookie 里的 SESSDATA",
						value: form.sessdata,
						onChange: (event) => setForm(Object.assign({}, form, { sessdata: event.target.value })),
					})),
					h(
						"div",
						{ style: { display: "flex", gap: 8, alignItems: "center" } },
						h("button", { style: buttonStyle(true), onClick: start, disabled: job && job.status === "running" }, "开始一轮"),
						h("button", { style: buttonStyle(false), onClick: save }, "保存设置"),
						notice && h("span", { style: { fontSize: 12, color: COLORS.muted } }, notice),
					),
				),

				job &&
					h(
						"div",
						{ style: box() },
						h(
							"div",
							{ style: { fontSize: 13 } },
							job.status === "running" ? "进行中：" + progressText : job.status === "done" ? "已完成" : "失败：" + job.error,
						),
					),

				result &&
					h(
						"div",
						null,
						result.mode === "mood" &&
							h(
								"div",
								{ style: box({ background: "rgba(127,127,127,0.06)" }) },
								h(
									"div",
									{ style: { fontSize: 13 } },
									"心情：" +
										(result.mood.tone || "随意") +
										(result.mood.preset ? "（" + result.mood.preset.label + "）" : "") +
										" ｜ 关键词：" +
										((result.mood.keywords || []).join("、") || "无"),
								),
								result.diary && h("div", { style: { fontSize: 12, color: COLORS.muted, marginTop: 4 } }, "心情日记：" + result.diary),
								result.report && h("div", { style: { fontSize: 12, color: COLORS.muted, marginTop: 2 } }, "速览报告：" + result.report),
							),
						h(
							"div",
							{ style: { fontSize: 13, margin: "4px 0 8px" } },
							"可读 " +
								result.stats.readable +
								" 条 ｜ 丢弃 " +
								result.stats.dropped +
								" 条 ｜ 字幕 " +
								result.stats.charsIn +
								" 字 → 入模 " +
								result.stats.charsOut +
								" 字（省 " +
								result.stats.saved +
								"%）",
						),
						h("ul", { style: { listStyle: "none", padding: 0, margin: 0 } }, result.sections.map((section) =>
							h(Section, { key: section.bvid, section: section }),
						)),
						result.skipped.length > 0 &&
							h(
								"details",
								{ style: { fontSize: 12, color: COLORS.muted, marginTop: 8 } },
								h("summary", null, "被丢弃 " + result.skipped.length + " 条"),
								h(
									"ul",
									{ style: { paddingLeft: 18, marginTop: 6 } },
									result.skipped.map((item) => {
										var reason = String(item.reason || item.verdict || "");
										var blind = /no-subtitle|bad-subtitle/.test(reason);
										return h(
											"li",
											{ key: item.bvid, style: { marginBottom: blind ? 10 : 0 } },
											item.bvid + " ｜ " + (item.title || "") + " ｜ " + reason,
											blind && h(Frames, { bvid: item.bvid, label: "没有字幕，看画面" }),
										);
									}),
								),
							),
					),
			);
		}

		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject(
				"plugins.item",
				() =>
					ctx.slots.register(
						{
							name: "plugins.item",
							id: NS,
							order: 40,
							label: () => "B 站字幕速览",
						},
						Panel,
					),
			);
		}

		exports.name = NS;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
