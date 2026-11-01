// DSH Web client plugin — NOT standard ESM. The host loads this file through
// window.__ModuleLoader__, which calls factory(require) and expects
// module.exports back. `require` resolves only host-provided modules.
//
// P1 registers one settings section: workspace/host management plus a control
// surface for sessions, permission requests, widen previews, and written rules.
// Conversation tool cards and the permission dock are P2 and will move into
// `conversation.*` slots then.
window.__ModuleLoader__.load({
	id: 'dsh-claude-workspace',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const react = require('react')
		const jsxRuntime = require('react/jsx-runtime')
		const h = jsxRuntime.jsx
		const { useState, useEffect, useCallback } = react

		const NS = 'dsh-claude-workspace'
		const SECTION_ID = 'dsh-claude-workspace.settings'
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
			sessions: '会话',
			openSession: '打开会话',
			workspaceField: '工作区',
			sessionIdField: 'DSH 会话 ID',
			modelField: '模型（可选）',
			open: '打开',
			noSessions: '还没有会话绑定。',
			prompt: '发送任务',
			promptPlaceholder: '描述要在这个工作区完成的任务…',
			send: '发送',
			approvals: '待审批',
			noApprovals: '没有待审批的请求。',
			allow: '允许',
			widenPrefix: '放宽为本命令前缀',
			widenTool: '放宽为本工具',
			widenPreview: '预览规则',
			rules: '已写入的规则',
			revoke: '撤销',
			noRules: '还没有由本插件写入的规则。',
			refresh: '刷新',
			error: '操作失败',
			warning: '提示',
			confirmHint: '放宽规则会写入 settings.local.json，请先预览。',
			highRisk: '该命令有破坏性风险，需要确认。',
			confirm: '确认写入',
			cancel: '取消',
			close: '关闭',
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
			sessions: 'Sessions',
			openSession: 'Open session',
			workspaceField: 'Workspace',
			sessionIdField: 'DSH session id',
			modelField: 'Model (optional)',
			open: 'Open',
			noSessions: 'No session bindings yet.',
			prompt: 'Send a task',
			promptPlaceholder: 'Describe the task for this workspace…',
			send: 'Send',
			approvals: 'Pending approvals',
			noApprovals: 'No pending requests.',
			allow: 'Allow',
			widenPrefix: 'Widen to command prefix',
			widenTool: 'Widen to tool',
			widenPreview: 'Preview rule',
			rules: 'Written rules',
			revoke: 'Revoke',
			noRules: 'No rules have been written by this plugin.',
			refresh: 'Refresh',
			error: 'Request failed',
			warning: 'Notice',
			confirmHint: 'Widening writes to settings.local.json; preview the rule first.',
			highRisk: 'This command looks destructive and needs confirmation.',
			confirm: 'Write rule',
			cancel: 'Cancel',
			close: 'Close',
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
			textarea: { font: 'inherit', fontSize: '12px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer)', color: 'inherit', minHeight: '56px', resize: 'vertical' },
			button: { font: 'inherit', fontSize: '12px', padding: '3px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l3)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
			primary: { font: 'inherit', fontSize: '12px', padding: '3px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-state-business-primary, #4b7bec)', background: 'transparent', color: 'var(--dsw-alias-state-business-primary, #4b7bec)', cursor: 'pointer' },
			danger: { font: 'inherit', fontSize: '12px', padding: '3px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-state-error-primary, #d4380d)', background: 'transparent', color: 'var(--dsw-alias-state-error-primary, #d4380d)', cursor: 'pointer' },
			error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #d4380d)' },
			code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', whiteSpace: 'pre-wrap' },
		}

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

		function SettingsSection(props) {
			const t = props.t
			const [status, setStatus] = useState(null)
			const [hosts, setHosts] = useState([])
			const [workspaces, setWorkspaces] = useState([])
			const [sessions, setSessions] = useState([])
			const [pending, setPending] = useState([])
			const [rules, setRules] = useState([])
			const [error, setError] = useState('')
			const [notice, setNotice] = useState('')
			const [probes, setProbes] = useState({})
			const [title, setTitle] = useState('')
			const [hostId, setHostId] = useState('')
			const [dir, setDir] = useState('')
			const [sessionWorkspace, setSessionWorkspace] = useState('')
			const [sessionId, setSessionId] = useState('')
			const [model, setModel] = useState('')
			const [promptText, setPromptText] = useState('')
			const [preview, setPreview] = useState(null)
			const [busy, setBusy] = useState(false)

			const refresh = useCallback(async () => {
				try {
					const [nextStatus, nextHosts, nextWorkspaces, nextSessions, nextPending, nextRules] = await Promise.all([
						call('/status'),
						call('/hosts'),
						call('/workspaces'),
						call('/sessions'),
						call('/approvals'),
						call('/rules'),
					])
					setStatus(nextStatus)
					setHosts(nextHosts.hosts || [])
					setWorkspaces(nextWorkspaces.workspaces || [])
					setSessions(nextSessions.sessions || [])
					setPending(nextPending.pending || [])
					setRules(nextRules.rules || [])
					setError('')
					if (!hostId && nextHosts.hosts && nextHosts.hosts.length > 0) setHostId(nextHosts.hosts[0].id)
					if (!sessionWorkspace && nextWorkspaces.workspaces && nextWorkspaces.workspaces.length > 0) {
						setSessionWorkspace(nextWorkspaces.workspaces[0].id)
					}
				} catch (failure) {
					setError(failure.message)
				}
			}, [hostId, sessionWorkspace])

			useEffect(() => { void refresh() }, [refresh])

			const run = async (action) => {
				setBusy(true)
				setError('')
				setNotice('')
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
				const result = await post('/workspaces/create', {
					hostId,
					...(title ? { title } : {}),
					...(dir ? { dir } : {}),
				})
				setTitle('')
				setDir('')
				setNotice((result.warnings || []).join(' '))
			})

			const removeWorkspace = (id) => run(async () => {
				await post('/workspaces/remove', { workspaceId: id })
			})

			const openSession = () => run(async () => {
				const result = await post('/sessions/open', {
					workspaceId: sessionWorkspace,
					dshSessionId: sessionId,
					...(model ? { model } : {}),
				})
				setNotice(`session ${sessionId} bound to ${result.binding.cwd}`)
			})

			const sendPrompt = () => run(async () => {
				const result = await post('/sessions/prompt', { dshSessionId: sessionId, text: promptText })
				setNotice(`turn finished: ${result.stopReason}`)
				setPromptText('')
			})

			const answer = (requestId, optionId) => run(async () => {
				await post('/approvals/answer', { requestId, optionId })
			})

			const previewWiden = (requestId, scope) => run(async () => {
				const result = await post('/approvals/widen-preview', { requestId, scope })
				setPreview({ ...result, scope })
			})

			const applyWiden = (confirmed) => run(async () => {
				await post('/approvals/widen', {
					requestId: preview.requestId,
					scope: preview.scope,
					...(confirmed ? { confirmed: true } : {}),
				})
				setPreview(null)
			})

			const revoke = (id) => run(async () => {
				await post('/rules/revoke', { id })
			})

			const section = (key, body) => h('section', { style: styles.card, children: [
				h('h3', { style: styles.cardTitle, children: key }),
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
				notice ? h('div', { style: { ...styles.muted, fontSize: '12px' }, children: notice }) : null,

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
				]) : null,

				section(t('hosts'), [
					h('div', { style: styles.list, children: hosts.map((host) => h('div', { key: host.id, style: styles.item, children: [
						h('span', { children: host.id }),
						h('span', { style: styles.badge, children: host.kind }),
						host.default ? h('span', { style: styles.badge, children: 'default' }) : null,
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
							h('span', { style: styles.badge, children: workspace.hostId }),
							h('code', { style: { ...styles.code, ...styles.muted }, children: workspace.dir }),
							workspace.state === 'active'
								? h('button', { style: styles.danger, onClick: () => void removeWorkspace(workspace.id), children: t('remove') })
								: h('span', { style: styles.badge, children: 'removed' }),
						] })) }),
				]),

				section(t('openSession'), [
					h(Field, { label: t('workspaceField'), value: sessionWorkspace, onChange: setSessionWorkspace }),
					h(Field, { label: t('sessionIdField'), value: sessionId, onChange: setSessionId }),
					h(Field, { label: t('modelField'), value: model, onChange: setModel }),
					h('div', { style: styles.row, children: [
						h('button', { style: styles.primary, onClick: () => void openSession(), disabled: busy || !sessionWorkspace || !sessionId, children: t('open') }),
					] }),
					h('div', { style: styles.list, children: sessions.length === 0
						? [h('div', { key: 'none', style: { ...styles.muted, fontSize: '12px' }, children: t('noSessions') })]
						: sessions.map((binding) => h('div', { key: binding.dshSessionId, style: styles.item, children: [
							h('span', { children: binding.dshSessionId }),
							h('span', { style: styles.badge, children: binding.workspaceId }),
							h('span', { style: { ...styles.code, ...styles.muted }, children: binding.cwd }),
							binding.needsLoad ? h('span', { style: styles.badge, children: 'needs load' }) : null,
						].filter(Boolean) })) }),
					h('div', { style: styles.row, children: [
						h('span', { style: styles.muted, children: t('prompt') }),
					] }),
					h('textarea', {
						style: styles.textarea,
						value: promptText,
						placeholder: t('promptPlaceholder'),
						onChange: (event) => setPromptText(event.target.value),
					}),
					h('div', { style: styles.row, children: [
						h('button', { style: styles.primary, onClick: () => void sendPrompt(), disabled: busy || !sessionId || !promptText, children: t('send') }),
					] }),
				]),

				section(t('approvals'), [
					h('div', { style: styles.list, children: pending.length === 0
						? [h('div', { key: 'none', style: { ...styles.muted, fontSize: '12px' }, children: t('noApprovals') })]
						: pending.map((request) => h('div', { key: request.requestId, style: styles.item, children: [
							h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 auto' }, children: [
								h('span', { children: request.toolCall.title || request.toolCall.toolCallId }),
								h('code', { style: { ...styles.code, ...styles.muted }, children: `${request.sessionId} · ${request.requestId}` }),
							] }),
							h('div', { style: styles.row, children: [
								...request.options.map((option) => h('button', {
									key: option.optionId,
									style: option.kind && option.kind.indexOf('reject') === 0 ? styles.danger : styles.primary,
									onClick: () => void answer(request.requestId, option.optionId),
									children: option.name || option.optionId,
								})),
								h('button', { style: styles.button, onClick: () => void previewWiden(request.requestId, 'prefix'), children: t('widenPrefix') }),
								h('button', { style: styles.button, onClick: () => void previewWiden(request.requestId, 'tool'), children: t('widenTool') }),
							] }),
						] })) }),
					h('div', { style: { ...styles.muted, fontSize: '11px' }, children: t('confirmHint') }),
					preview ? h('div', { style: { ...styles.card, marginTop: '4px' }, children: [
						h('div', { style: styles.row, children: h('span', { children: t('widenPreview') }) }),
						h('code', { style: styles.code, children: preview.rules.join('\n') }),
						h('code', { style: { ...styles.code, ...styles.muted }, children: preview.file }),
						preview.notes.map((note) => h('div', { key: note, style: { ...styles.muted, fontSize: '11px' }, children: note })),
						preview.highRisk ? h('div', { style: styles.error, children: t('highRisk') }) : null,
						h('div', { style: styles.row, children: [
							h('button', { style: styles.primary, onClick: () => void applyWiden(true), children: t('confirm') }),
							h('button', { style: styles.button, onClick: () => setPreview(null), children: t('cancel') }),
						] }),
					].filter(Boolean) }) : null,
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
		}

		exports.apply = apply
		exports.inject = inject
		exports.NS = NS
		exports.SECTION_ID = SECTION_ID
		exports.SettingsSection = SettingsSection
		return module.exports
	},
})
