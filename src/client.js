// DSH Web client plugin — NOT standard ESM. The host loads this file through
// window.__ModuleLoader__, which calls factory(require) and expects
// module.exports back. `require` resolves only host-provided modules.
//
// Two surfaces:
//   - settings.section: hosts, workspaces, and CCW-written permission rules.
//   - a right-Sidebar tab type (`claude-workspace`): the session console with
//     the message stream, tool cards, diffs, plan card, permission dock,
//     model/effort/mode selectors, stop button, replay separator, and pending
//     approval count on the tab title.
//
// The console talks to the loopback HTTP API. It is independent of the DSH
// agent loop: P1 does not take over agent-loop, so this tab manages CCW
// sessions directly rather than mirroring a DSH conversation.
window.__ModuleLoader__.load({
	id: 'dsh-claude-workspace',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const react = require('react')
		const jsxRuntime = require('react/jsx-runtime')
		const h = jsxRuntime.jsx
		const Fragment = react.Fragment
		const { useState, useEffect, useCallback, useRef } = react

		const NS = 'dsh-claude-workspace'
		const SECTION_ID = 'dsh-claude-workspace.settings'
		const PANEL_ID = 'dsh-claude-workspace'
		const PANEL_KIND = 'claude-workspace'
		const BASE = '/api/dsh-claude-workspace'

		const zh = {
			sectionNav: 'Claude Code 工作区',
			title: 'Claude Code 工作区',
			intro: '在本地或远程主机上管理工作区与 Claude Code 会话。插件不保存任何凭据；目标机的 claude 需要已登录。',
			status: '状态',
			dataDir: '数据目录',
			strategy: '目录策略',
			registry: 'DSH 工作区注册',
			registryOn: '已连接',
			registryOff: '不可用（仅插件内记录）',
			hosts: '主机',
			probe: '检查',
			probeOk: '可用',
			probeFail: '不可用',
			workspaces: '工作区',
			createWorkspace: '新建工作区',
			titleField: '标题（可选）',
			hostField: '主机',
			dirField: '目录（留空则自动派生）',
			create: '创建',
			remove: '从 DSH 移除',
			noWorkspaces: '还没有工作区。',
			rules: '已写入的规则',
			revoke: '撤销',
			noRules: '还没有由本插件写入的规则。',
			refresh: '刷新',
			error: '操作失败',
			warning: '提示',
			confirmHint: '放宽规则会写入 settings.local.json，请先预览。',
			highRisk: '该命令有破坏性风险，需要确认。',
			confirm: '写入并允许',
			cancel: '取消',
			close: '关闭',
			settingsNote: '会话控制台在右侧栏的 Claude Code 标签中（通过右侧栏引导页打开）。',
			panelTitle: 'Claude Code',
			panelDescription: '工作区会话、工具卡、diff 与权限判断',
			sessionField: '会话 ID',
			openSession: '打开',
			openWorkspace: '工作区',
			stateReady: '就绪',
			stateBusy: '运行中',
			stateDisconnected: '已断开',
			stateStopped: '未启动',
			reconnect: '重连',
			reconnecting: '重连中…',
			stop: '停止',
			approvals: '待审批',
			noApprovals: '没有待审批的请求。',
			pendingApprovals: '个待审批',
			autoApproved: '自动放行',
			send: '发送',
			sending: '发送中…',
			promptPlaceholder: '描述要在这个工作区完成的任务…',
			replayHistory: '历史回放',
			thinking: '思考',
			noEvents: '还没有消息。',
			toolPending: '待批准',
			toolRunning: '运行中',
			toolOk: '完成',
			toolFailed: '失败',
			toolCancelled: '已中断',
			planTitle: '计划',
			approve: '批准执行',
			revise: '修改计划',
			cancelPlan: '取消',
			feedbackPlaceholder: '补充或修改意见…',
			widenPrefix: '放宽为本命令前缀',
			widenTool: '放宽为本工具',
			widenPreview: '即将写入的规则',
			widenCancel: '取消放宽',
			turnFinished: '回合结束',
			sessionOpened: '会话已打开',
			diffTruncated: 'diff 过大，仅显示统计',
			changedLines: '行变更',
			attachFile: '@ 文件',
			attachImage: '图片',
			imageTooLarge: '图片超过 2 MB',
			imageTooMany: '最多附加 4 张图片',
			pickerEmpty: '目录为空',
			pickerTitle: '选择文件',
			commandsTitle: '命令',
			hostDefault: '默认',
			stateRemoved: '已移除',
			sessionsLabel: '个会话',
			modeLabel: '模式',
			toolLabel: '工具',
			subagent: '子 agent',
			nativeSession: '新建 Claude 会话',
			nativeOpened: '已在新会话中打开 Claude',
			nativeCreated: '会话已创建',
		}

		const en = {
			sectionNav: 'Claude Code workspaces',
			title: 'Claude Code workspaces',
			intro: 'Manage workspaces and Claude Code sessions on this host or over SSH. No credentials are stored here; the target machine must already be logged in.',
			status: 'Status',
			dataDir: 'Data directory',
			strategy: 'Directory policy',
			registry: 'DSH workspace registry',
			registryOn: 'connected',
			registryOff: 'unavailable (plugin-only records)',
			hosts: 'Hosts',
			probe: 'Check',
			probeOk: 'available',
			probeFail: 'unavailable',
			workspaces: 'Workspaces',
			createWorkspace: 'New workspace',
			titleField: 'Title (optional)',
			hostField: 'Host',
			dirField: 'Directory (blank derives one)',
			create: 'Create',
			remove: 'Remove from DSH',
			noWorkspaces: 'No workspaces yet.',
			rules: 'Written rules',
			revoke: 'Revoke',
			noRules: 'No rules have been written by this plugin.',
			refresh: 'Refresh',
			error: 'Request failed',
			warning: 'Notice',
			confirmHint: 'Widening writes to settings.local.json; preview the rule first.',
			highRisk: 'This command looks destructive and needs confirmation.',
			confirm: 'Write and allow',
			cancel: 'Cancel',
			close: 'Close',
			settingsNote: 'The session console lives in the right-sidebar Claude Code tab (open it from the right-sidebar guide).',
			panelTitle: 'Claude Code',
			panelDescription: 'Workspace sessions, tool cards, diffs, and permission decisions',
			sessionField: 'Session id',
			openSession: 'Open',
			openWorkspace: 'Workspace',
			stateReady: 'ready',
			stateBusy: 'running',
			stateDisconnected: 'disconnected',
			stateStopped: 'stopped',
			reconnect: 'Reconnect',
			reconnecting: 'Reconnecting…',
			stop: 'Stop',
			approvals: 'Pending approvals',
			noApprovals: 'No pending requests.',
			pendingApprovals: 'pending',
			autoApproved: 'auto',
			send: 'Send',
			sending: 'Sending…',
			promptPlaceholder: 'Describe the task for this workspace…',
			replayHistory: 'History replay',
			thinking: 'Thinking',
			noEvents: 'No messages yet.',
			toolPending: 'awaiting approval',
			toolRunning: 'running',
			toolOk: 'done',
			toolFailed: 'failed',
			toolCancelled: 'interrupted',
			planTitle: 'Plan',
			approve: 'Approve and run',
			revise: 'Revise plan',
			cancelPlan: 'Cancel',
			feedbackPlaceholder: 'Add or change the plan…',
			widenPrefix: 'Widen to command prefix',
			widenTool: 'Widen to tool',
			widenPreview: 'Rule to write',
			widenCancel: 'Cancel widen',
			turnFinished: 'Turn finished',
			sessionOpened: 'Session opened',
			diffTruncated: 'diff too large; showing counts only',
			changedLines: 'line changes',
			attachFile: '@ file',
			attachImage: 'Image',
			imageTooLarge: 'Image is larger than 2 MB',
			imageTooMany: 'At most 4 images',
			pickerEmpty: 'Directory is empty',
			pickerTitle: 'Choose a file',
			commandsTitle: 'Commands',
			hostDefault: 'default',
			stateRemoved: 'removed',
			sessionsLabel: 'sessions',
			modeLabel: 'mode',
			toolLabel: 'tool',
			subagent: 'Subagent',
			nativeSession: 'New Claude session',
			nativeOpened: 'Opened Claude in a new session',
			nativeCreated: 'Session created',
		}

		const styles = {
			root: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 2px 24px', height: '100%', overflowY: 'auto' },
			heading: { margin: 0, fontSize: '16px', fontWeight: 600 },
			intro: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)', maxWidth: '720px' },
			card: { border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '10px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' },
			cardTitle: { margin: 0, fontSize: '13px', fontWeight: 600 },
			row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px' },
			muted: { color: 'var(--dsw-alias-label-tertiary)' },
			list: { display: 'flex', flexDirection: 'column', gap: '6px' },
			item: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-2)', fontSize: '12px' },
			badge: { fontSize: '11px', padding: '0 6px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l3)', color: 'var(--dsw-alias-label-secondary)' },
			input: { font: 'inherit', fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer)', color: 'inherit' },
			select: { font: 'inherit', fontSize: '12px', padding: '3px 6px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer)', color: 'inherit' },
			textarea: { font: 'inherit', fontSize: '12px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer)', color: 'inherit', minHeight: '56px', resize: 'vertical' },
			button: { font: 'inherit', fontSize: '12px', padding: '3px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l3)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
			primary: { font: 'inherit', fontSize: '12px', padding: '3px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-state-business-primary, #4b7bec)', background: 'transparent', color: 'var(--dsw-alias-state-business-primary, #4b7bec)', cursor: 'pointer' },
			danger: { font: 'inherit', fontSize: '12px', padding: '3px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-state-error-primary, #d4380d)', background: 'transparent', color: 'var(--dsw-alias-state-error-primary, #d4380d)', cursor: 'pointer' },
			error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #d4380d)' },
			code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', whiteSpace: 'pre-wrap' },

			panel: { display: 'flex', flexDirection: 'column', gap: '8px', height: '100%', minHeight: 0, padding: '8px', boxSizing: 'border-box' },
			panelHeader: { display: 'flex', flexDirection: 'column', gap: '6px', flex: '0 0 auto' },
			panelRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '12px' },
			stream: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', padding: '2px' },
			composer: { flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid var(--dsw-alias-border-l4)', paddingTop: '8px' },
			dock: { flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '6px' },
			message: { fontSize: '13px', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
			messageMd: { fontSize: '13px', lineHeight: 1.55, wordBreak: 'break-word' },
			mdParagraph: { margin: '2px 0 6px' },
			mdCode: { ...{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' }, padding: '0 3px', borderRadius: '4px', background: 'var(--dsw-alias-bg-layer-2)' },
			mdPre: { margin: '4px 0 8px', padding: '8px', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer)', overflowX: 'auto' },
			mdPreCode: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', whiteSpace: 'pre-wrap' },
			mdLang: { fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)', marginBottom: '4px' },
			mdHeading: { margin: '8px 0 4px', fontWeight: 600 },
			mdHr: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l3)', margin: '8px 0' },
			mdQuote: { margin: '4px 0 8px', paddingLeft: '10px', borderLeft: '3px solid var(--dsw-alias-border-l3)', color: 'var(--dsw-alias-label-secondary)' },
			mdList: { margin: '4px 0 8px', paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '2px' },
			mdTable: { borderCollapse: 'collapse', fontSize: '12px', margin: '6px 0 10px' },
			mdTh: { border: '1px solid var(--dsw-alias-border-l3)', padding: '3px 8px', background: 'var(--dsw-alias-bg-layer)', textAlign: 'left' },
			mdTd: { border: '1px solid var(--dsw-alias-border-l3)', padding: '3px 8px' },
			mdLink: { color: 'var(--dsw-alias-state-business-primary, #4b7bec)', textDecoration: 'underline' },
			messageUser: { fontSize: '13px', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '6px 10px', borderRadius: '10px', background: 'var(--dsw-alias-bg-layer-2)', alignSelf: 'flex-end', maxWidth: '90%' },
			thinking: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
			replay: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
			rule: { flex: '1 1 auto', height: '1px', background: 'var(--dsw-alias-border-l4)' },
			tool: { border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '8px', padding: '6px 8px', background: 'var(--dsw-alias-bg-layer-2)' },
			toolSummary: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '12px' },
			diff: { marginTop: '6px', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '6px', overflow: 'hidden', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px' },
			hunkHead: { padding: '2px 6px', color: 'var(--dsw-alias-label-tertiary)', background: 'var(--dsw-alias-bg-layer)' },
			diffLine: { display: 'flex', gap: '8px', padding: '0 6px', whiteSpace: 'pre' },
			lineNo: { width: '3ch', flex: '0 0 auto', textAlign: 'right', color: 'var(--dsw-alias-label-tertiary)', userSelect: 'none' },
			addLine: { background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #237804) 12%, transparent)' },
			removeLine: { background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #d4380d) 12%, transparent)' },
			dockCard: { border: '1px solid var(--dsw-alias-state-business-primary, #4b7bec)', borderRadius: '10px', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '6px', background: 'var(--dsw-alias-bg-layer)' },
			plan: { border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '8px', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px' },
			menu: { display: 'flex', flexDirection: 'column', gap: '2px', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '8px', padding: '4px', background: 'var(--dsw-alias-bg-layer)', maxHeight: '180px', overflowY: 'auto' },
			menuItem: { display: 'flex', alignItems: 'baseline', gap: '8px', textAlign: 'left', font: 'inherit', fontSize: '12px', padding: '3px 6px', border: 'none', borderRadius: '6px', background: 'transparent', color: 'inherit', cursor: 'pointer' },
			picker: { display: 'flex', flexDirection: 'column', gap: '2px', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '8px', padding: '4px', background: 'var(--dsw-alias-bg-layer)', maxHeight: '220px', overflowY: 'auto' },
			pickerItem: { textAlign: 'left', font: 'inherit', fontSize: '12px', padding: '3px 6px', border: 'none', borderRadius: '6px', background: 'transparent', color: 'inherit', cursor: 'pointer' },
			chip: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', padding: '0 6px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l3)', color: 'var(--dsw-alias-label-secondary)' },
			subagentTree: { display: 'flex', flexDirection: 'column', gap: '6px', marginLeft: '10px', paddingLeft: '8px', borderLeft: '2px solid var(--dsw-alias-border-l3)' },
			statusDot: { width: '7px', height: '7px', borderRadius: '999px', display: 'inline-block' },
		}

		// ── pure helpers (exported for tests) ─────────────────────────────────

		/** Merges event envelopes by seq and trims to the newest `limit`. */
		function mergeEvents(previous, incoming, limit) {
			const seen = new Set(previous.map((event) => event.seq))
			const merged = previous.slice()
			for (const event of incoming) {
				if (event === null || event === undefined || seen.has(event.seq)) continue
				merged.push(event)
				seen.add(event.seq)
			}
			return limit > 0 && merged.length > limit ? merged.slice(merged.length - limit) : merged
		}

		/** Merges adjacent text chunks of the same kind and replay state. */
		function groupEvents(events) {
			const groups = []
			for (const event of events) {
				const last = groups.length > 0 ? groups[groups.length - 1] : undefined
				const isText = event.type === 'assistant-text' || event.type === 'thinking' || event.type === 'user-text'
				if (isText && last !== undefined && last.type === event.type && last.replay === event.replay) {
					groups[groups.length - 1] = { ...last, text: last.text + event.text, seq: event.seq }
				} else {
					groups.push(event)
				}
			}
			return groups
		}

		/** Latest card per toolCallId, in first-seen order, with subagent children grouped by launch id. */
		function collectToolCards(events) {
			const cards = new Map()
			const order = []
			for (const event of events) {
				if (event === null || event === undefined) continue
				if (event.type !== 'tool-call' && event.type !== 'tool-update') continue
				const card = event.card
				if (!cards.has(card.toolCallId)) order.push(card.toolCallId)
				cards.set(card.toolCallId, card)
			}
			const childrenByParent = new Map()
			for (const id of order) {
				const card = cards.get(id)
				const parent = card.parentToolCallId
				if (parent === undefined || !cards.has(parent)) continue
				const children = childrenByParent.get(parent) ?? []
				children.push(card)
				childrenByParent.set(parent, children)
			}
			return { cards, order, childrenByParent }
		}

		/** Flattens a config option's flat or grouped select values into `{value,name}`. */
		function flattenSelectValues(options) {
			const values = []
			for (const entry of options || []) {
				if (entry === null || entry === undefined) continue
				if (typeof entry.value === 'string') values.push({ value: entry.value, name: entry.name || entry.value })
				else if (Array.isArray(entry.options)) values.push(...flattenSelectValues(entry.options))
			}
			return values
		}

		/** Whether a persisted binding can be resumed in this Host process. */
		function needsResume(runtime, running, bound) {
			return running !== true && bound === true && (runtime === 'disconnected' || runtime === 'stopped')
		}

		/** One-line argument summary for a tool card or permission request. */
		function toolInputSummary(toolCall) {
			if (toolCall === null || toolCall === undefined) return ''
			const raw = toolCall.rawInput
			if (raw !== null && typeof raw === 'object') {
				for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
					if (typeof raw[key] === 'string' && raw[key].length > 0) return clip(raw[key])
				}
				try {
					return clip(JSON.stringify(raw))
				} catch {
					return ''
				}
			}
			const location = Array.isArray(toolCall.locations) ? toolCall.locations[0] : undefined
			return location && typeof location.path === 'string' ? clip(location.path) : ''
		}

		/** Latest `available_commands_update` payload in an event stream. */
		function latestCommands(events) {
			for (let index = events.length - 1; index >= 0; index -= 1) {
				const event = events[index]
				if (event !== null && event !== undefined && event.type === 'commands') return event.commands || []
			}
			return []
		}

		/** Commands whose `/name` prefix matches the draft. */
		function matchCommands(commands, draft) {
			if (typeof draft !== 'string' || !draft.startsWith('/')) return []
			const needle = draft.toLowerCase()
			return (commands || [])
				.filter((command) => command && typeof command.name === 'string' && `/${command.name}`.toLowerCase().startsWith(needle))
				.slice(0, 8)
		}

		/** Auto-approved tool calls and the rule that allowed them. */
		function autoApprovals(events) {
			const approved = {}
			for (const event of events) {
				if (event !== null && event !== undefined && event.type === 'auto-approved') {
					approved[event.toolCallId] = event.rule
				}
			}
			return approved
		}

		/** Path relative to a root directory, or the absolute path when outside it. */
		function relativeWithin(root, path) {
			const base = root.replace(/\/+$/, '')
			if (path === base) return '.'
			if (path.startsWith(`${base}/`)) return path.slice(base.length + 1)
			return path
		}

		/** Parent directory, never above the picker root. */
		function parentDirectory(directory, root) {
			const base = root.replace(/\/+$/, '')
			if (directory === base) return root
			const parent = directory.replace(/\/+$/, '').replace(/\/[^/]+$/, '')
			return parent.length < base.length ? root : parent
		}

		const MAX_IMAGES = 4
		const MAX_IMAGE_BYTES = 2 * 1024 * 1024
		const MAX_IMAGE_EDGE = 2048

		/** Fit one image into a square box, preserving its aspect ratio. */
		function scaledDimensions(width, height, maxEdge = MAX_IMAGE_EDGE) {
			const longest = Math.max(width, height)
			if (!(longest > maxEdge)) return { width, height }
			const scale = maxEdge / longest
			return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
		}

		/** Decoded byte length of a base64 payload. */
		function base64Bytes(base64) {
			const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
			return Math.floor((base64.length * 3) / 4) - padding
		}

		/** Reads one browser File as an ACP image block payload. */
		function readImageFile(file) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader()
				reader.onload = () => {
					const result = typeof reader.result === 'string' ? reader.result : ''
					const match = /^data:([^;]+);base64,(.*)$/.exec(result)
					if (match === null) {
						reject(new Error('unsupported image'))
						return
					}
					resolve({ data: match[2], mimeType: match[1], name: file.name })
				}
				reader.onerror = () => reject(new Error('could not read image'))
				reader.readAsDataURL(file)
			})
		}

		function blobToPayload(blob, name) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader()
				reader.onload = () => {
					const result = typeof reader.result === 'string' ? reader.result : ''
					const match = /^data:([^;]+);base64,(.*)$/.exec(result)
					if (match === null) reject(new Error('unsupported encoded image'))
					else resolve({ data: match[2], mimeType: match[1], name })
				}
				reader.onerror = () => reject(new Error('could not read encoded image'))
				reader.readAsDataURL(blob)
			})
		}

		function loadBitmap(file) {
			if (typeof createImageBitmap === 'function') return createImageBitmap(file)
			return new Promise((resolve, reject) => {
				const url = URL.createObjectURL(file)
				const image = new Image()
				image.onload = () => {
					URL.revokeObjectURL(url)
					resolve(image)
				}
				image.onerror = () => {
					URL.revokeObjectURL(url)
					reject(new Error('could not decode image'))
				}
				image.src = url
			})
		}

		function drawScaled(bitmap, size) {
			if (typeof OffscreenCanvas === 'function') {
				const canvas = new OffscreenCanvas(size.width, size.height)
				canvas.getContext('2d').drawImage(bitmap, 0, 0, size.width, size.height)
				return canvas
			}
			const canvas = document.createElement('canvas')
			canvas.width = size.width
			canvas.height = size.height
			canvas.getContext('2d').drawImage(bitmap, 0, 0, size.width, size.height)
			return canvas
		}

		function canvasBlob(canvas, type, quality) {
			if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality })
			return new Promise((resolve, reject) => canvas.toBlob(
				(blob) => (blob === null ? reject(new Error('could not encode image')) : resolve(blob)),
				type,
				quality,
			))
		}

		/**
		 * Downscale an image until it fits the per-image byte budget, keeping PNG
		 * for transparent sources on the first attempt and falling back to JPEG.
		 */
		async function compressImage(file) {
			const bitmap = await loadBitmap(file)
			try {
				const width = bitmap.width ?? bitmap.naturalWidth
				const height = bitmap.height ?? bitmap.naturalHeight
				let size = scaledDimensions(width, height)
				let type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
				for (let attempt = 0; attempt < 4; attempt += 1) {
					const payload = await blobToPayload(await canvasBlob(drawScaled(bitmap, size), type, 0.85), file.name)
					if (base64Bytes(payload.data) <= MAX_IMAGE_BYTES) return payload
					type = 'image/jpeg'
					const edge = Math.max(512, Math.round(Math.max(size.width, size.height) / 2))
					size = scaledDimensions(size.width, size.height, edge)
				}
			} finally {
				bitmap.close?.()
			}
			throw new Error('image could not be compressed below the size limit')
		}

		/** Attach an image as-is when it fits, otherwise downscale it first. */
		async function prepareImage(file) {
			if (file.size <= MAX_IMAGE_BYTES) return readImageFile(file)
			return compressImage(file)
		}

		function clip(text) {
			return text.length > 220 ? `${text.slice(0, 219)}…` : text
		}

		// ── lightweight Markdown (assistant text) ─────────────────────────────

		/** Split one table row into trimmed cells. */
		function splitTableRow(line) {
			return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
		}

		function isTableSeparator(line) {
			return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
		}

		/** Inline Markdown tokens: code, strong, emphasis, strike, links. */
		function parseInline(text) {
			const tokens = []
			const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]*\]\([^)]*\))/g
			let last = 0
			let match
			while ((match = pattern.exec(text)) !== null) {
				if (match.index > last) tokens.push({ type: 'text', text: text.slice(last, match.index) })
				const raw = match[0]
				if (raw.startsWith('`')) tokens.push({ type: 'code', text: raw.slice(1, -1) })
				else if (raw.startsWith('**') || raw.startsWith('__')) tokens.push({ type: 'strong', children: parseInline(raw.slice(2, -2)) })
				else if (raw.startsWith('~~')) tokens.push({ type: 'strike', children: parseInline(raw.slice(2, -2)) })
				else if (raw.startsWith('*') || raw.startsWith('_')) tokens.push({ type: 'em', children: parseInline(raw.slice(1, -1)) })
				else {
					const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(raw)
					if (link !== null) tokens.push({ type: 'link', text: link[1], href: link[2] })
				}
				last = match.index + raw.length
			}
			if (last < text.length) tokens.push({ type: 'text', text: text.slice(last) })
			return tokens
		}

		/** Block-level Markdown: fences, headings, rules, quotes, tables, lists, paragraphs. */
		function parseMarkdown(text) {
			const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
			const blocks = []
			const startsBlock = (line, index) => /^\s*(```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(line)
				|| /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)
				|| (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1]))
			let index = 0
			while (index < lines.length) {
				const line = lines[index]
				if (line.trim() === '') {
					index += 1
					continue
				}
				const fence = /^\s*```\s*(\S*)\s*$/.exec(line)
				if (fence !== null) {
					const body = []
					index += 1
					while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
						body.push(lines[index])
						index += 1
					}
					if (index < lines.length) index += 1
					blocks.push({ type: 'code', lang: fence[1] || '', text: body.join('\n') })
					continue
				}
				const heading = /^(#{1,6})\s+(.*)$/.exec(line)
				if (heading !== null) {
					blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
					index += 1
					continue
				}
				if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
					blocks.push({ type: 'hr' })
					index += 1
					continue
				}
				if (/^\s*>\s?/.test(line)) {
					const quoted = []
					while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
						quoted.push(lines[index].replace(/^\s*>\s?/, ''))
						index += 1
					}
					blocks.push({ type: 'quote', text: quoted.join('\n') })
					continue
				}
				if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
					const header = splitTableRow(line)
					index += 2
					const rows = []
					while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
						rows.push(splitTableRow(lines[index]))
						index += 1
					}
					blocks.push({ type: 'table', header, rows })
					continue
				}
				const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
				if (listItem !== null) {
					const ordered = /\d/.test(listItem[2])
					const items = []
					while (index < lines.length) {
						const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index])
						if (item === null || /\d/.test(item[2]) !== ordered) break
						items.push({ indent: item[1].length, text: item[3] })
						index += 1
					}
					blocks.push({ type: 'list', ordered, items })
					continue
				}
				const paragraph = []
				while (index < lines.length && lines[index].trim() !== '' && !startsBlock(lines[index], index)) {
					paragraph.push(lines[index])
					index += 1
				}
				if (paragraph.length === 0) {
					// A marker that started no block (for example a lone list marker):
					// consume it as text so the loop always advances.
					paragraph.push(lines[index])
					index += 1
				}
				blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
			}
			return blocks
		}

		function safeMarkdownHref(href) {
			return /^(https?:\/\/|mailto:)/i.test(href)
		}

		function renderInlineTokens(tokens, keyPrefix) {
			return tokens.map((token, index) => {
				const key = `${keyPrefix}-${index}`
				switch (token.type) {
					case 'text': return token.text
					case 'code': return h('code', { key, style: styles.mdCode }, token.text)
					case 'strong': return h('strong', { key }, renderInlineTokens(token.children, key))
					case 'em': return h('em', { key }, renderInlineTokens(token.children, key))
					case 'strike': return h('del', { key }, renderInlineTokens(token.children, key))
					case 'link': return safeMarkdownHref(token.href)
						? h('a', { key, href: token.href, target: '_blank', rel: 'noreferrer', style: styles.mdLink, children: renderInlineTokens(parseInline(token.text), key) })
						: h(Fragment, { key }, token.text)
					default: return null
				}
			})
		}

		/** Render paragraph text with soft line breaks preserved as <br>. */
		function renderInlineText(text, keyPrefix) {
			const parts = text.split('\n')
			const nodes = []
			parts.forEach((part, index) => {
				if (index > 0) nodes.push(h('br', { key: `${keyPrefix}-br-${index}` }))
				nodes.push(...renderInlineTokens(parseInline(part), `${keyPrefix}-${index}`))
			})
			return nodes
		}

		/** Render assistant Markdown without raw HTML; links are limited to http(s)/mailto. */
		function renderMarkdownNodes(text, keyPrefix = 'md') {
			return parseMarkdown(text).map((block, index) => {
				const key = `${keyPrefix}-${index}`
				switch (block.type) {
					case 'code': return h('pre', { key, style: styles.mdPre }, [
						block.lang ? h('div', { key: 'lang', style: styles.mdLang, children: block.lang }) : null,
						h('code', { key: 'code', style: styles.mdPreCode, children: block.text }),
					].filter(Boolean))
					case 'heading': return h(`h${Math.min(block.level + 2, 6)}`, { key, style: styles.mdHeading }, renderInlineText(block.text, key))
					case 'hr': return h('hr', { key, style: styles.mdHr })
					case 'quote': return h('blockquote', { key, style: styles.mdQuote }, renderInlineText(block.text, key))
					case 'list': return h(block.ordered ? 'ol' : 'ul', { key, style: styles.mdList }, block.items.map((item, itemIndex) => h('li', {
						key: `li-${itemIndex}`,
						style: item.indent > 0 ? { marginLeft: `${Math.min(item.indent, 8) * 6}px` } : undefined,
						children: renderInlineText(item.text, `${key}-li-${itemIndex}`),
					})))
					case 'table': return h('table', { key, style: styles.mdTable }, [
						h('thead', { key: 'head', children: h('tr', { children: block.header.map((cell, cellIndex) => h('th', {
							key: `h-${cellIndex}`, style: styles.mdTh, children: renderInlineText(cell, `${key}-h-${cellIndex}`),
						})) }) }),
						h('tbody', { key: 'body', children: block.rows.map((row, rowIndex) => h('tr', {
							key: `r-${rowIndex}`,
							children: row.map((cell, cellIndex) => h('td', {
								key: `c-${cellIndex}`, style: styles.mdTd, children: renderInlineText(cell, `${key}-r-${rowIndex}-c-${cellIndex}`),
							})),
						})) }),
					])
					case 'paragraph': return h('p', { key, style: styles.mdParagraph }, renderInlineText(block.text, key))
					default: return null
				}
			})
		}

		// ── HTTP ─────────────────────────────────────────────────────────────

		async function call(path, options) {
			const response = await fetch(`${BASE}${path}`, {
				headers: { accept: 'application/json', 'content-type': 'application/json' },
				...options,
			})
			const body = await response.json().catch(() => ({}))
			if (!response.ok || body.ok !== true) {
				const message = body && body.error && body.error.message ? body.error.message : `request failed (${response.status})`
				throw new Error(message)
			}
			return body.data
		}

		function post(path, payload) {
			return call(path, { method: 'POST', body: JSON.stringify(payload || {}) })
		}

		// ── shared bits ──────────────────────────────────────────────────────

		function Field(props) {
			return h('label', { style: styles.row, children: [
				h('span', { style: styles.muted, children: props.label }),
				h('input', {
					style: { ...styles.input, flex: '1 1 180px' },
					value: props.value,
					placeholder: props.placeholder || '',
					onChange: (event) => props.onChange(event.target.value),
				}),
			] })
		}

		function Badge(props) {
			return h('span', { style: { ...styles.badge, ...(props.style || {}) }, children: props.children })
		}

		function diffLine(line, index) {
			const kindStyle = line.kind === 'add' ? styles.addLine : line.kind === 'remove' ? styles.removeLine : {}
			const number = line.oldLine !== undefined ? line.oldLine : line.newLine !== undefined ? line.newLine : ''
			const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
			return h('div', {
				key: `l${index}`,
				style: { ...styles.diffLine, ...kindStyle },
				children: [
					h('span', { style: styles.lineNo, children: String(number) }),
					h('span', { children: `${prefix}${line.text}` }),
				],
			})
		}

		function diffHunk(hunk, index) {
			return h('div', {
				key: `h${index}`,
				children: [
					h('div', {
						style: styles.hunkHead,
						children: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
					}),
					...hunk.lines.map(diffLine),
				],
			})
		}

		function DiffView(props) {
			const diff = props.diff
			if (diff.truncated) {
				return h('div', { style: styles.diff, children: [
					h('div', { style: styles.hunkHead, children: props.t('diffTruncated') }),
					h('div', { style: styles.diffLine, children: `+${diff.added} −${diff.removed}` }),
				] })
			}
			return h('div', { style: styles.diff, children: (diff.hunks || []).map(diffHunk) })
		}

		function statusStyle(status) {
			switch (status) {
				case 'running': return { color: 'var(--dsw-alias-state-business-primary, #4b7bec)' }
				case 'ok': return { color: 'var(--dsw-alias-state-success-primary, #237804)' }
				case 'failed': return { color: 'var(--dsw-alias-state-error-primary, #d4380d)' }
				case 'cancelled': return { color: 'var(--dsw-alias-label-tertiary)' }
				default: return { color: 'var(--dsw-alias-label-secondary)' }
			}
		}

		function statusLabel(t, status) {
			if (status === 'running') return t('toolRunning')
			if (status === 'ok') return t('toolOk')
			if (status === 'failed') return t('toolFailed')
			if (status === 'cancelled') return t('toolCancelled')
			return t('toolPending')
		}

		// ── settings section ────────────────────────────────────────────────

		function SettingsSection(props) {
			const t = props.t
			const [status, setStatus] = useState(null)
			const [hosts, setHosts] = useState([])
			const [workspaces, setWorkspaces] = useState([])
			const [rules, setRules] = useState([])
			const [error, setError] = useState('')
			const [busy, setBusy] = useState(false)
			const [probes, setProbes] = useState({})
			const [title, setTitle] = useState('')
			const [hostId, setHostId] = useState('')
			const [dir, setDir] = useState('')

			const refresh = useCallback(async () => {
				try {
					const [nextStatus, nextHosts, nextWorkspaces, nextRules] = await Promise.all([
						call('/status'), call('/hosts'), call('/workspaces'), call('/rules'),
					])
					setStatus(nextStatus)
					setHosts(nextHosts.hosts || [])
					setWorkspaces(nextWorkspaces.workspaces || [])
					setRules(nextRules.rules || [])
					setError('')
					if (!hostId && nextHosts.hosts && nextHosts.hosts.length > 0) setHostId(nextHosts.hosts[0].id)
				} catch (failure) {
					setError(failure.message)
				}
			}, [hostId])

			useEffect(() => { void refresh() }, [refresh])

			const run = async (action) => {
				setBusy(true)
				setError('')
				try {
					await action()
					await refresh()
				} catch (failure) {
					setError(failure.message)
				} finally {
					setBusy(false)
				}
			}

			const probe = (id) => run(async () => {
				const result = await post('/hosts/probe', { hostId: id })
				setProbes((current) => ({ ...current, [id]: result.health }))
			})
			const createWorkspace = () => run(async () => {
				await post('/workspaces/create', {
					hostId,
					...(title ? { title } : {}),
					...(dir ? { dir } : {}),
				})
				setTitle('')
				setDir('')
			})
			const removeWorkspace = (id) => run(async () => {
				await post('/workspaces/remove', { workspaceId: id })
			})
			const revoke = (id) => run(async () => {
				await post('/rules/revoke', { id })
			})

			const section = (heading, body) => h('section', { style: styles.card, children: [
				h('h3', { style: styles.cardTitle, children: heading }),
				...body,
			] })

			return h('div', { style: styles.root, children: [
				h('h2', { style: styles.heading, children: t('title') }),
				h('p', { style: styles.intro, children: t('intro') }),
				h('div', { style: styles.row, children: [
					h('button', { style: styles.button, onClick: () => void refresh(), children: t('refresh') }),
					busy ? h('span', { style: styles.muted, children: '…' }) : null,
				].filter(Boolean) }),
				error ? h('div', { style: styles.error, children: `${t('error')}: ${error}` }) : null,

				status ? section(t('status'), [
					h('div', { style: styles.row, children: [
						h('span', { style: styles.muted, children: t('dataDir') }),
						h('code', { style: styles.code, children: status.dataDir }),
					] }),
					h('div', { style: styles.row, children: [
						h('span', { style: styles.muted, children: t('strategy') }),
						h('span', { children: status.strategy }),
						h('span', { style: styles.muted, children: t('registry') }),
						h('span', { children: status.registryAvailable ? t('registryOn') : t('registryOff') }),
					] }),
					h('div', { style: { ...styles.muted, fontSize: '11px' }, children: t('settingsNote') }),
				]) : null,

				section(t('hosts'), [
					h('div', { style: styles.list, children: hosts.map((host) => h('div', { key: host.id, style: styles.item, children: [
						h('span', { children: host.id }),
						h(Badge, { children: host.kind }),
						host.default ? h(Badge, { children: t('hostDefault') }) : null,
						h('button', { style: styles.button, onClick: () => void probe(host.id), children: t('probe') }),
						probes[host.id]
							? h('span', {
								style: { ...styles.muted, ...styles.code },
								children: probes[host.id].ok
									? `${t('probeOk')}${probes[host.id].version ? ` · ${probes[host.id].version}` : ''}`
									: `${t('probeFail')} · ${probes[host.id].error || probes[host.id].nextAction || ''}`,
							})
							: null,
					].filter(Boolean) })) }),
				]),

				section(t('createWorkspace'), [
					h(Field, { label: t('titleField'), value: title, onChange: setTitle }),
					h(Field, { label: t('hostField'), value: hostId, onChange: setHostId, placeholder: hosts.map((host) => host.id).join(', ') }),
					h(Field, { label: t('dirField'), value: dir, onChange: setDir }),
					h('div', { style: styles.row, children: [
						h('button', { style: styles.primary, onClick: () => void createWorkspace(), disabled: busy || !hostId, children: t('create') }),
					] }),
					h('div', { style: styles.list, children: workspaces.length === 0
						? [h('div', { key: 'none', style: { ...styles.muted, fontSize: '12px' }, children: t('noWorkspaces') })]
						: workspaces.map((workspace) => h('div', { key: workspace.id, style: styles.item, children: [
							h('span', { children: workspace.title }),
							h(Badge, { children: workspace.hostId }),
							h('code', { style: { ...styles.code, ...styles.muted }, children: workspace.dir }),
							workspace.state === 'active'
								? h('button', { style: styles.danger, onClick: () => void removeWorkspace(workspace.id), children: t('remove') })
								: h(Badge, { children: t('stateRemoved') }),
						] })) }),
				]),

				section(t('rules'), [
					h('div', { style: styles.list, children: rules.length === 0
						? [h('div', { key: 'none', style: { ...styles.muted, fontSize: '12px' }, children: t('noRules') })]
						: rules.map((rule) => h('div', { key: rule.id, style: styles.item, children: [
							h('code', { style: styles.code, children: rule.rule }),
							h('span', { style: { ...styles.code, ...styles.muted }, children: rule.file }),
							h('button', { style: styles.danger, onClick: () => void revoke(rule.id), children: t('revoke') }),
						] })) }),
				]),
			].filter(Boolean) })
		}

		// ── session console ─────────────────────────────────────────────────

		function createConsole(t, ctx) {
			return function Console() {
				const [workspaces, setWorkspaces] = useState([])
				const [bindings, setBindings] = useState([])
				const [workspaceId, setWorkspaceId] = useState('')
				const [native, setNative] = useState(null)
				const [sessionId, setSessionId] = useState('')
				const [opened, setOpened] = useState(false)
				const [events, setEvents] = useState([])
				const [pending, setPending] = useState([])
				const [plan, setPlan] = useState(null)
				const [options, setOptions] = useState(null)
				const [running, setRunning] = useState(false)
				const [runtime, setRuntime] = useState('stopped')
				const [promptText, setPromptText] = useState('')
				const [sending, setSending] = useState(false)
				const [reconnecting, setReconnecting] = useState(false)
				const [busy, setBusy] = useState(false)
				const [error, setError] = useState('')
				const [notice, setNotice] = useState('')
				const [previews, setPreviews] = useState({})
				const [images, setImages] = useState([])
				const [imageError, setImageError] = useState('')
				const [picker, setPicker] = useState(null)
				const [reviseText, setReviseText] = useState('')
				const sinceRef = useRef(0)
				const streamRef = useRef(null)

				const refreshCatalog = useCallback(async () => {
					try {
						const [nextWorkspaces, nextBindings, status] = await Promise.all([
							call('/workspaces'), call('/sessions'), call('/status'),
						])
						const active = (nextWorkspaces.workspaces || []).filter((workspace) => workspace.state === 'active')
						setWorkspaces(active)
						setBindings(nextBindings.sessions || [])
						setNative(status.native || null)
						setWorkspaceId((current) => current || (active[0] ? active[0].id : ''))
						setError('')
					} catch (failure) {
						setError(failure.message)
					}
				}, [])

				useEffect(() => { void refreshCatalog() }, [refreshCatalog])
				useEffect(() => {
					if (!workspaceId || sessionId) return
					setSessionId(`ccw-${workspaceId}`)
				}, [workspaceId, sessionId])
				useEffect(() => {
					const node = streamRef.current
					if (node !== null && node !== undefined) node.scrollTop = node.scrollHeight
				}, [events.length, pending.length])

				useEffect(() => {
					if (!opened || !sessionId) return undefined
					let alive = true
					let timer
					const tick = async () => {
						try {
							const [approvals, reattach, planResult] = await Promise.all([
								call(`/approvals?dshSessionId=${encodeURIComponent(sessionId)}`),
								post('/sessions/reattach', { dshSessionId: sessionId, sinceSeq: sinceRef.current }),
								call(`/plans?dshSessionId=${encodeURIComponent(sessionId)}`),
							])
							if (!alive) return
							if (reattach.events && reattach.events.length > 0) {
								sinceRef.current = reattach.events[reattach.events.length - 1].seq
								setEvents((previous) => mergeEvents(previous, reattach.events.map((entry) => entry.event), 2000))
							}
							setPending(approvals.pending || [])
							setRunning(Boolean(reattach.running))
							setRuntime(reattach.state)
							setPlan(planResult.plan || null)
							setError('')
						} catch (failure) {
							if (alive) setError(failure.message)
						}
						if (alive) timer = setTimeout(tick, 800)
					}
					void tick()
					return () => {
						alive = false
						if (timer !== undefined) clearTimeout(timer)
					}
				}, [opened, sessionId])

				const run = async (action) => {
					setBusy(true)
					setError('')
					try {
						await action()
					} catch (failure) {
						setError(failure.message)
					} finally {
						setBusy(false)
					}
				}

				const openSession = () => run(async () => {
					const result = await post('/sessions/open', { workspaceId, dshSessionId: sessionId })
					setOpened(true)
					setNotice(t('sessionOpened'))
					sinceRef.current = 0
					setEvents([])
					setPending([])
					setPlan(null)
					setPreviews({})
					const shape = result.configOptions && result.configOptions.length > 0
						? { modes: result.modes, configOptions: result.configOptions }
						: (await call(`/sessions/options?dshSessionId=${encodeURIComponent(sessionId)}`)).options
					setOptions(shape || null)
					await refreshCatalog()
				})

				const createNativeSession = () => run(async () => {
					const result = await post('/sessions/native-create', { workspaceId })
					const ui = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
					const warnings = Array.isArray(result.warnings) ? result.warnings : []
					if (ui && typeof ui.openSession === 'function') {
						ui.openSession(result.sessionId)
						setNotice(warnings.length > 0
							? `${t('nativeOpened')}: ${warnings.join('; ')}`
							: t('nativeOpened'))
					} else {
						setNotice(warnings.length > 0
							? `${t('nativeCreated')} ${result.sessionId}: ${warnings.join('; ')}`
							: `${t('nativeCreated')}: ${result.sessionId}`)
					}
					await refreshCatalog()
				})

				const sendPrompt = async () => {
					if (running || sending) return
					setSending(true)
					setError('')
					try {
						const result = await post('/sessions/prompt', {
							dshSessionId: sessionId,
							text: promptText,
							...(images.length > 0
								? { images: images.map((image) => ({ data: image.data, mimeType: image.mimeType })) }
								: {}),
						})
						setNotice(`${t('turnFinished')}: ${result.stopReason}`)
						setPromptText('')
						setImages([])
						setImageError('')
						setPicker(null)
					} catch (failure) {
						setError(failure.message)
					} finally {
						setSending(false)
					}
				}

				const stop = () => run(async () => {
					await post('/sessions/cancel', { dshSessionId: sessionId })
				})

				const reconnect = async () => {
					setReconnecting(true)
					setError('')
					try {
						const result = await post('/sessions/reconnect', { dshSessionId: sessionId })
						sinceRef.current = 0
						setEvents([])
						setPending([])
						setPlan(null)
						const shape = result.configOptions && result.configOptions.length > 0
							? { modes: result.modes, configOptions: result.configOptions }
							: (await call(`/sessions/options?dshSessionId=${encodeURIComponent(sessionId)}`)).options
						if (shape !== null && shape !== undefined) setOptions(shape)
						setNotice(t('sessionOpened'))
					} catch (failure) {
						setError(failure.message)
					} finally {
						setReconnecting(false)
					}
				}

				const addImages = async (fileList) => {
					setImageError('')
					const files = Array.from(fileList || [])
					const accepted = []
					for (const file of files) {
						if (!file.type || !file.type.startsWith('image/')) continue
						try {
							accepted.push(await prepareImage(file))
						} catch {
							setImageError(t('imageTooLarge'))
						}
					}
					setImages((current) => {
						const combined = [...current, ...accepted]
						if (combined.length > MAX_IMAGES) setImageError(t('imageTooMany'))
						return combined.slice(0, MAX_IMAGES)
					})
				}

				const pickerUrl = (dir) => {
					const query = new URLSearchParams({ workspaceId, dshSessionId: sessionId })
					if (dir !== undefined) query.set('dir', dir)
					return `/workspaces/files?${query.toString()}`
				}

				const openPicker = async () => {
					setError('')
					try {
						const data = await call(pickerUrl())
						setPicker({ root: data.dir, dir: data.dir, entries: data.entries || [], loading: false, error: '' })
					} catch (failure) {
						setError(failure.message)
					}
				}

				const navigatePicker = async (dir) => {
					setPicker((current) => (current === null ? current : { ...current, loading: true, error: '' }))
					try {
						const data = await call(pickerUrl(dir))
						setPicker((current) => (current === null ? current : {
							...current, dir: data.dir, entries: data.entries || [], loading: false, error: '',
						}))
					} catch (failure) {
						setPicker((current) => (current === null ? current : { ...current, loading: false, error: failure.message }))
					}
				}

				const insertFile = (path) => {
					const relative = relativeWithin(picker.root, path)
					setPromptText((text) => `${text}${text.length > 0 && !text.endsWith(' ') ? ' ' : ''}@${relative} `)
					setPicker(null)
				}

				const answer = (requestId, optionId) => run(async () => {
					await post('/approvals/answer', { requestId, optionId })
					setPreviews((current) => ({ ...current, [requestId]: undefined }))
				})

				const previewWiden = (requestId, scope) => run(async () => {
					const preview = await post('/approvals/widen-preview', { requestId, scope })
					setPreviews((current) => ({ ...current, [requestId]: { ...preview, scope } }))
				})

				const applyWiden = (requestId, preview) => run(async () => {
					await post('/approvals/widen', {
						requestId,
						scope: preview.scope,
						...(preview.rules && preview.rules.length > 0 ? { confirmed: true } : {}),
					})
					setPreviews((current) => ({ ...current, [requestId]: undefined }))
				})

				const changeOption = (configId, value) => run(async () => {
					await post('/sessions/option', { dshSessionId: sessionId, configId, value })
					const next = await call(`/sessions/options?dshSessionId=${encodeURIComponent(sessionId)}`)
					setOptions(next.options || options)
				})

				const decidePlan = (decision) => run(async () => {
					await post('/plans/decide', {
						dshSessionId: sessionId,
						decision,
						...(decision === 'revise' ? { feedback: reviseText } : {}),
					})
					setReviseText('')
				})

				const stateLabel = runtime === 'busy' ? t('stateBusy') : runtime === 'disconnected' ? t('stateDisconnected') : runtime === 'ready' ? t('stateReady') : t('stateStopped')
				const stateColor = runtime === 'busy' ? 'var(--dsw-alias-state-business-primary, #4b7bec)' : runtime === 'disconnected' ? 'var(--dsw-alias-state-error-primary, #d4380d)' : runtime === 'ready' ? 'var(--dsw-alias-state-success-primary, #237804)' : 'var(--dsw-alias-label-tertiary)'
				// SSH workspaces are supported too; the Host reports a missing
				// probeCwd as an actionable error when the button is used.
				const canCreateNative = Boolean(native && native.available)
				const boundSession = bindings.find((binding) => binding.dshSessionId === sessionId)
				const showResume = needsResume(runtime, running, boundSession !== undefined)
				const groups = groupEvents(events)
				const toolTree = collectToolCards(events)
				const renderedTools = new Set()
				const commands = latestCommands(events)
				const commandMatches = matchCommands(commands, promptText)
				const approvedByRule = autoApprovals(events)
				const renderToolCard = (card, opacity) => {
					const children = toolTree.childrenByParent.get(card.toolCallId) ?? []
					return h('details', {
						key: `tool-${card.toolCallId}`,
						open: card.status === 'running' || card.status === 'pending' || children.length > 0,
						style: { ...styles.tool, ...opacity },
						children: [
							h('summary', { style: styles.toolSummary, children: [
								h(Badge, { children: card.kind || t('toolLabel') }),
								children.length > 0 ? h(Badge, { children: `${t('subagent')} · ${children.length}` }) : null,
								approvedByRule[card.toolCallId]
									? h(Badge, { style: { color: 'var(--dsw-alias-state-success-primary, #237804)' }, children: t('autoApproved') })
									: null,
								h('span', { style: { flex: '1 1 auto' }, children: card.title }),
								h('span', { style: { ...styles.badge, ...statusStyle(card.status) }, children: statusLabel(t, card.status) }),
							].filter(Boolean) }),
							toolInputSummary(card) ? h('code', { style: { ...styles.code, ...styles.muted }, children: toolInputSummary(card) }) : null,
							...(card.diffs || []).map((diff, index) => h(DiffView, { key: `d${index}`, diff, t })),
							...(card.content || [])
								.filter((entry) => entry.type === 'content' && entry.content && entry.content.type === 'text')
								.map((entry, index) => h('div', { key: `c${index}`, style: { ...styles.code, ...styles.muted }, children: entry.content.text })),
							children.length > 0
								? h('div', { style: styles.subagentTree, children: children.map((child) => renderToolCard(child, {})) })
								: null,
						].filter(Boolean),
					})
				}
				let sawReplay = false
				const streamNodes = []
				for (const item of groups) {
					if (item.replay && !sawReplay) {
						sawReplay = true
						streamNodes.push(h('div', { key: `replay-${item.seq}`, style: styles.replay, children: [
							h('span', { children: t('replayHistory') }),
							h('span', { style: styles.rule }),
						] }))
					}
					const opacity = item.replay ? { opacity: 0.72 } : {}
					if (item.type === 'assistant-text') {
						streamNodes.push(h('div', { key: `a-${item.seq}`, style: { ...styles.messageMd, ...opacity }, children: renderMarkdownNodes(item.text) }))
					} else if (item.type === 'user-text') {
						streamNodes.push(h('div', { key: `u-${item.seq}`, style: { ...styles.messageUser, ...opacity }, children: item.text }))
					} else if (item.type === 'thinking') {
						streamNodes.push(h('details', { key: `t-${item.seq}`, style: { ...styles.thinking, ...opacity }, children: [
							h('summary', { children: t('thinking') }),
							h('div', { style: styles.message, children: item.text }),
						] }))
					} else if (item.type === 'tool-call' || item.type === 'tool-update') {
						const card = toolTree.cards.get(item.card.toolCallId) ?? item.card
						const parent = card.parentToolCallId
						if ((parent !== undefined && toolTree.cards.has(parent)) || renderedTools.has(card.toolCallId)) continue
						renderedTools.add(card.toolCallId)
						streamNodes.push(renderToolCard(card, opacity))
					} else if (item.type === 'plan') {
						streamNodes.push(h('div', { key: `p-${item.seq}`, style: { ...styles.plan, ...opacity }, children: [
							h('div', { style: styles.cardTitle, children: t('planTitle') }),
							...item.entries.map((entry, index) => h('div', { key: `e${index}`, style: styles.row, children: [
								h(Badge, { children: entry.status }),
								h('span', { children: entry.content }),
							] })),
						] }))
					} else if (item.type === 'mode') {
						streamNodes.push(h('div', { key: `m-${item.seq}`, style: { ...styles.row, ...opacity }, children: [
							h('span', { style: styles.muted, children: t('modeLabel') }),
							h(Badge, { children: item.modeId }),
						] }))
					}
				}

				const optionNodes = []
				const configOptions = options && Array.isArray(options.configOptions) ? options.configOptions : []
				for (const option of configOptions) {
					if (option.type === 'select') {
						const values = flattenSelectValues(option.options)
						optionNodes.push(h('label', { key: option.id, style: styles.panelRow, children: [
							h('span', { style: styles.muted, children: option.name || option.id }),
							h('select', {
								style: styles.select,
								value: typeof option.currentValue === 'string' ? option.currentValue : '',
								onChange: (event) => void changeOption(option.id, event.target.value),
								children: values.map((value) => h('option', { key: value.value, value: value.value, children: value.name })),
							}),
						] }))
					} else if (option.type === 'boolean') {
						optionNodes.push(h('label', { key: option.id, style: styles.panelRow, children: [
							h('input', {
								type: 'checkbox',
								checked: option.currentValue === true,
								onChange: (event) => void changeOption(option.id, event.target.checked),
							}),
							h('span', { children: option.name || option.id }),
						] }))
					}
				}

				const dockNodes = pending.map((request) => {
					const preview = previews[request.requestId]
					return h('div', { key: request.requestId, style: styles.dockCard, children: [
						h('div', { style: styles.row, children: [
							h(Badge, { children: request.toolCall.kind || t('toolLabel') }),
							h('span', { style: { flex: '1 1 auto', fontWeight: 600 }, children: request.toolCall.title || request.toolCall.toolCallId }),
							h('span', { style: styles.muted, children: request.sessionId }),
						] }),
						toolInputSummary(request.toolCall) ? h('code', { style: styles.code, children: toolInputSummary(request.toolCall) }) : null,
						h('div', { style: styles.panelRow, children: [
							...request.options.map((option) => h('button', {
								key: option.optionId,
								style: option.kind && option.kind.indexOf('reject') === 0 ? styles.danger : styles.primary,
								onClick: () => void answer(request.requestId, option.optionId),
								children: option.name || option.optionId,
							})),
							h('button', { style: styles.button, onClick: () => void previewWiden(request.requestId, 'prefix'), children: t('widenPrefix') }),
							h('button', { style: styles.button, onClick: () => void previewWiden(request.requestId, 'tool'), children: t('widenTool') }),
						] }),
						preview ? h('div', { style: { ...styles.plan, marginTop: '2px' }, children: [
							h('div', { style: styles.cardTitle, children: t('widenPreview') }),
							h('code', { style: styles.code, children: (preview.rules || []).join('\n') }),
							h('code', { style: { ...styles.code, ...styles.muted }, children: preview.file }),
							...((preview.notes || []).map((note) => h('div', { key: note, style: { ...styles.muted, fontSize: '11px' }, children: note }))),
							preview.highRisk ? h('div', { style: styles.error, children: t('highRisk') }) : null,
							h('div', { style: styles.panelRow, children: [
								h('button', { style: styles.primary, onClick: () => void applyWiden(request.requestId, preview), children: t('confirm') }),
								h('button', { style: styles.button, onClick: () => setPreviews((current) => ({ ...current, [request.requestId]: undefined })), children: t('widenCancel') }),
							] }),
						].filter(Boolean) }) : null,
					].filter(Boolean) })
				})

				const planCard = plan ? h('div', { style: styles.plan, children: [
					h('div', { style: styles.row, children: [
						h('span', { style: styles.cardTitle, children: t('planTitle') }),
						plan.decision ? h(Badge, { children: plan.decision.kind }) : null,
					].filter(Boolean) }),
					...plan.entries.map((entry, index) => h('div', { key: `pe${index}`, style: styles.row, children: [
						h(Badge, { children: entry.status }),
						h('span', { children: entry.content }),
					] })),
					plan.decision ? null : h(Fragment, { children: [
						h('textarea', {
							style: styles.textarea,
							value: reviseText,
							placeholder: t('feedbackPlaceholder'),
							onChange: (event) => setReviseText(event.target.value),
						}),
						h('div', { style: styles.panelRow, children: [
							h('button', { style: styles.primary, onClick: () => void decidePlan('approve'), children: t('approve') }),
							h('button', { style: styles.button, disabled: reviseText.trim().length === 0, onClick: () => void decidePlan('revise'), children: t('revise') }),
							h('button', { style: styles.danger, onClick: () => void decidePlan('cancel'), children: t('cancelPlan') }),
						] }),
					] }),
				].filter(Boolean) }) : null

				return h('div', { style: styles.panel, children: [
					h('div', { style: styles.panelHeader, children: [
						h('div', { style: styles.panelRow, children: [
							h('span', { style: { ...styles.statusDot, background: stateColor } }),
							h('span', { children: stateLabel }),
							h('span', { style: { ...styles.muted, flex: '1 1 auto' }, children: sessionId || '' }),
							running ? h('button', { style: styles.danger, onClick: () => void stop(), children: t('stop') }) : null,
							showResume
								? h('button', {
									style: styles.primary,
									disabled: reconnecting,
									onClick: () => void reconnect(),
									children: reconnecting ? t('reconnecting') : t('reconnect'),
								})
								: null,
							h('button', { style: styles.button, onClick: () => void refreshCatalog(), children: t('refresh') }),
						].filter(Boolean) }),
						h('div', { style: styles.panelRow, children: [
							h('span', { style: styles.muted, children: t('openWorkspace') }),
							h('select', {
								style: styles.select,
								value: workspaceId,
								onChange: (event) => {
									setWorkspaceId(event.target.value)
									setSessionId(`ccw-${event.target.value}`)
									setOpened(false)
								},
								children: workspaces.map((workspace) => h('option', { key: workspace.id, value: workspace.id, children: workspace.title })),
							}),
							h('input', {
								style: { ...styles.input, flex: '1 1 140px' },
								value: sessionId,
								placeholder: t('sessionField'),
								onChange: (event) => {
									setSessionId(event.target.value)
									setOpened(false)
									sinceRef.current = 0
									setEvents([])
									setPending([])
									setPlan(null)
								},
							}),
							h('button', {
								style: styles.primary,
								disabled: busy || !workspaceId || !sessionId,
								onClick: () => void openSession(),
								children: t('openSession'),
							}),
							canCreateNative
								? h('button', {
									style: styles.button,
									disabled: busy || !workspaceId,
									onClick: () => void createNativeSession(),
									children: t('nativeSession'),
								})
								: null,
						] }),
						optionNodes.length > 0 ? h('div', { style: styles.panelRow, children: optionNodes }) : null,
						pending.length > 0 ? h('div', { style: styles.panelRow, children: [
							h(Badge, { style: { color: 'var(--dsw-alias-state-error-primary, #d4380d)' }, children: `${pending.length} ${t('approvals')}` }),
						] }) : null,
					].filter(Boolean) }),
					error ? h('div', { style: styles.error, children: `${t('error')}: ${error}` }) : null,
					notice ? h('div', { style: { ...styles.muted, fontSize: '11px' }, children: notice }) : null,
					h('div', { ref: streamRef, style: styles.stream, children: streamNodes.length > 0
						? streamNodes
						: [h('div', { key: 'empty', style: { ...styles.muted, fontSize: '12px' }, children: t('noEvents') })] }),
					planCard,
					h('div', { style: styles.dock, children: pending.length === 0
						? []
						: [h('div', { key: 'dock-title', style: { ...styles.muted, fontSize: '11px' }, children: t('approvals') }), ...dockNodes] }),
					h('div', { style: styles.composer, children: [
						commandMatches.length > 0 ? h('div', { style: styles.menu, children: commandMatches.map((command) => h('button', {
							key: command.name,
							style: styles.menuItem,
							onClick: () => setPromptText(`/${command.name} `),
							children: [
								h('code', { children: `/${command.name}` }),
								h('span', { style: { ...styles.muted, fontSize: '11px' }, children: command.description || '' }),
							],
						})) }) : null,
						picker !== null ? h('div', { style: styles.picker, children: [
							h('div', { style: styles.panelRow, children: [
								h('button', {
									style: styles.button,
									onClick: () => void navigatePicker(parentDirectory(picker.dir, picker.root)),
									children: '..',
								}),
								h('code', { style: { ...styles.code, ...styles.muted, flex: '1 1 auto' }, children: relativeWithin(picker.root, picker.dir) }),
								h('button', { style: styles.button, onClick: () => setPicker(null), children: t('close') }),
							] }),
							picker.loading ? h('div', { style: { ...styles.muted, fontSize: '11px' }, children: '…' }) : null,
							picker.error ? h('div', { style: styles.error, children: picker.error }) : null,
							picker.entries.length === 0 && !picker.loading
								? h('div', { style: { ...styles.muted, fontSize: '11px' }, children: t('pickerEmpty') })
								: null,
							...picker.entries.map((entry) => h('button', {
								key: entry.path,
								style: styles.pickerItem,
								onClick: () => {
									if (entry.isDirectory) void navigatePicker(entry.path)
									else insertFile(entry.path)
								},
								children: `${entry.isDirectory ? '▸ ' : '· '}${entry.name}`,
							})),
						].filter(Boolean) }) : null,
						images.length > 0 ? h('div', { style: styles.panelRow, children: images.map((image, index) => h('span', {
							key: `${image.name}-${index}`,
							style: styles.chip,
							children: [
								h('span', { children: image.name }),
								h('button', {
									style: { font: 'inherit', border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer' },
									onClick: () => setImages((current) => current.filter((_, position) => position !== index)),
									children: '×',
								}),
							],
						})) }) : null,
						imageError ? h('div', { style: { ...styles.muted, fontSize: '11px' }, children: imageError }) : null,
						h('textarea', {
							style: styles.textarea,
							value: promptText,
							placeholder: t('promptPlaceholder'),
							onChange: (event) => setPromptText(event.target.value),
							onKeyDown: (event) => {
								if (event.key === 'Escape') {
									if (picker !== null) {
										event.preventDefault()
										setPicker(null)
									}
									return
								}
								if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
									event.preventDefault()
									void sendPrompt()
								}
							},
						}),
						h('div', { style: styles.panelRow, children: [
							h('button', { style: styles.button, onClick: () => void openPicker(), children: t('attachFile') }),
							h('label', { style: styles.button, children: [
								t('attachImage'),
								h('input', {
									type: 'file',
									accept: 'image/*',
									multiple: true,
									style: { display: 'none' },
									onChange: (event) => {
										void addImages(event.target.files)
										event.target.value = ''
									},
								}),
							] }),
							h('button', {
								style: styles.primary,
								disabled: busy || sending || running || !opened || runtime === 'disconnected' || promptText.trim().length === 0,
								onClick: () => void sendPrompt(),
								children: sending ? t('sending') : t('send'),
							}),
							h('span', { style: { ...styles.muted, flex: '1 1 auto' }, children: bindings.length > 0 ? `${bindings.length} ${t('sessionsLabel')}` : '' }),
						] }),
					] }),
				].filter(Boolean) })
			}
		}

		function createConsoleTitle(t) {
			return function ConsoleTitle() {
				const [count, setCount] = useState(0)
				useEffect(() => {
					let alive = true
					const load = async () => {
						try {
							const data = await call('/approvals')
							if (alive) setCount((data.pending || []).length)
						} catch {
							// The tab title stays quiet while the host is unavailable.
						}
					}
					void load()
					const timer = setInterval(() => { void load() }, 3000)
					return () => { alive = false; clearInterval(timer) }
				}, [])
				return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' }, children: [
					h('span', { children: t('panelTitle') }),
					count > 0 ? h('span', {
						style: {
							minWidth: '16px', height: '16px', padding: '0 4px', borderRadius: '999px',
							background: 'var(--dsw-alias-state-error-primary, #d4380d)', color: '#fff',
							fontSize: '10px', lineHeight: '16px', textAlign: 'center',
						},
						children: String(count),
					}) : null,
				].filter(Boolean) })
			}
		}

		const inject = ['slots', 'locale']

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-claude-workspace: dictionaries')
			const t = ctx.locale.bind(NS)
			ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: SECTION_ID,
				order: 70,
				label: () => t('sectionNav'),
				locale: NS,
				inject: () => ({ t }),
			}, SettingsSection))

			const Console = createConsole(t, ctx)
			const ConsoleTitle = createConsoleTitle(t)
			const registerPanel = (scope, tabs) => {
				scope.effect(() => tabs.register({
					id: PANEL_ID,
					kind: PANEL_KIND,
					priority: 'extension',
					title: () => t('panelTitle'),
					guide: [{
						id: 'console',
						order: 80,
						title: () => t('panelTitle'),
						description: () => t('panelDescription'),
					}],
				}), 'dsh-claude-workspace: right-sidebar tab type')
				scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
					name: 'sidebar.right.pane.tab',
					key: PANEL_ID,
					locale: NS,
				}, Console))
				scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
					name: 'sidebar.right.pane.tab.title',
					key: PANEL_ID,
					locale: NS,
				}, ConsoleTitle))
			}
			// Optional services are read through ctx.get(); the property proxy
			// rejects names the fiber did not declare in its static inject list.
			if (typeof ctx.get === 'function') {
				const tabs = ctx.get('sidebarRightTabs')
				if (tabs !== undefined && tabs !== null) {
					registerPanel(ctx, tabs)
				} else if (typeof ctx.inject === 'function') {
					ctx.inject(['sidebarRightTabs'], (scope) => {
						const scoped = typeof scope.get === 'function' ? scope.get('sidebarRightTabs') : undefined
						if (scoped !== undefined && scoped !== null) registerPanel(scope, scoped)
					})
				}
			}
		}

		exports.apply = apply
		exports.inject = inject
		exports.NS = NS
		exports.SECTION_ID = SECTION_ID
		exports.PANEL_ID = PANEL_ID
		exports.PANEL_KIND = PANEL_KIND
		exports.SettingsSection = SettingsSection
		exports.mergeEvents = mergeEvents
		exports.groupEvents = groupEvents
		exports.collectToolCards = collectToolCards
		exports.needsResume = needsResume
		exports.parseMarkdown = parseMarkdown
		exports.parseInline = parseInline
		exports.splitTableRow = splitTableRow
		exports.flattenSelectValues = flattenSelectValues
		exports.toolInputSummary = toolInputSummary
		exports.latestCommands = latestCommands
		exports.matchCommands = matchCommands
		exports.autoApprovals = autoApprovals
		exports.relativeWithin = relativeWithin
		exports.parentDirectory = parentDirectory
		exports.scaledDimensions = scaledDimensions
		exports.base64Bytes = base64Bytes
		return module.exports
	},
})
