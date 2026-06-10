import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from './i18n'
import { GetConfig, SaveConfig, PrepareOVMS, ResetOVMS, ResetModels, CheckStatus, GetStartupEnabled, SetStartup, SearchModels, ExportTextGen, ExportEmbeddings, PullModel, StartOVMS, StopOVMS, IsOVMSRunning, GetOVMSRuntimeStatus, GetInstalledModels, DeleteInstalledModel, GetAvailableDevices, Chat, GetPipelineFilters, RunBenchmark, UpdateOVMSToLatest, GetSystemLanguage } from '../wailsjs/go/main/App'
import { EventsOn, BrowserOpenURL } from '../wailsjs/runtime/runtime'

const DEFAULT_OPTS_TEXT_GEN = '{}'
const DEFAULT_OPTS_EMBEDDING = '{\n  "weight-format": "fp16",\n  "extra_quantization_params": "--library sentence_transformers"\n}'

const CATEGORY_GROUPS = {
  text: { label: 'Text', types: ['text-generation', 'image-text-to-text'] },
  embeddings: { label: 'Embeddings', types: ['feature-extraction', 'sentence-similarity'] },
}

const PROGRESS_MAP = {
  'Downloading OVMS': 15,
  'Extracting OVMS': 25,
  'OVMS ready': 30,
  'Downloading export bundle': 60,
  'Installing export bundle': 85,
  'Setup complete': 100,
}

function StatusBadge({ ready, label, onUpdate }) {
  return (
    <div
      className={`status-badge ${ready ? 'ready' : 'missing'}${onUpdate ? ' updatable' : ''}`}
      onClick={onUpdate}
      title={onUpdate ? 'Update to latest' : undefined}
    >
      <span className="status-dot" />
      {label}
    </div>
  )
}

function LatencyChart({ latencies, avg, p95 }) {
  if (!latencies || latencies.length === 0) return null
  const W = 480, H = 130
  const PAD = { top: 12, right: 12, bottom: 28, left: 52 }
  const cW = W - PAD.left - PAD.right
  const cH = H - PAD.top - PAD.bottom
  const maxVal = Math.max(...latencies) * 1.15
  const barSlot = cW / latencies.length
  const barW = Math.max(3, barSlot - 3)
  const sy = v => cH - (v / maxVal) * cH
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      {latencies.map((l, i) => {
        const bH = (l / maxVal) * cH
        const x = PAD.left + i * barSlot + (barSlot - barW) / 2
        return <rect key={i} x={x} y={PAD.top + sy(l)} width={barW} height={bH} fill="#1d6ed8" rx="1" />
      })}
      <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + sy(avg)} y2={PAD.top + sy(avg)} stroke="#4ec9b0" strokeWidth="1" strokeDasharray="4 3" />
      <text x={PAD.left - 4} y={PAD.top + sy(avg) + 4} textAnchor="end" fontSize="9" fill="#4ec9b0">avg</text>
      {p95 > avg && <>
        <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + sy(p95)} y2={PAD.top + sy(p95)} stroke="#e0a040" strokeWidth="1" strokeDasharray="4 3" />
        <text x={PAD.left - 4} y={PAD.top + sy(p95) + 4} textAnchor="end" fontSize="9" fill="#e0a040">p95</text>
      </>}
      <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} stroke="#333" strokeWidth="1" />
      <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={H - PAD.bottom} stroke="#333" strokeWidth="1" />
      <text x={PAD.left - 4} y={PAD.top + 8} textAnchor="end" fontSize="9" fill="#555">{Math.round(maxVal)}ms</text>
      <text x={PAD.left - 4} y={H - PAD.bottom + 1} textAnchor="end" fontSize="9" fill="#555">0</text>
      {latencies.map((_, i) => (
        <text key={i} x={PAD.left + i * barSlot + barSlot / 2} y={H - PAD.bottom + 12} textAnchor="middle" fontSize="9" fill="#555">{i + 1}</text>
      ))}
    </svg>
  )
}

export default function App() {
  const { t } = useTranslation()
  const [tab, setTab] = useState('server')
  const [config, setConfig] = useState({
    install_dir: '',
    ovms_url: '',
    uv_url: '',
    api_port: 3333,
    ovms_rest_port: 8080,
    log_level: 'INFO',
    search_tags: [],
    pipeline_filters: [],
    search_limit: 30,
    text_gen_target_device: 'GPU',
    embeddings_target_device: 'CPU',
    enabled_categories: ['text'],
  })
  const [newTag, setNewTag] = useState('')
  const [saved, setSaved] = useState(false)
  const [startup, setStartup] = useState(false)
  const [status, setStatus] = useState(null)
  const [logs, setLogs] = useState([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)

  const [initStep, setInitStep] = useState('Checking setup…')
  const [initError, setInitError] = useState(null)
  const [progress, setProgress] = useState(0)

  const [serverRunning, setServerRunning] = useState(false)
  const [serverLogs, setServerLogs] = useState([])
  const [ovmsRuntime, setOvmsRuntime] = useState({ ready: false, version: '' })

  const [targetDevice, setTargetDevice] = useState('GPU')
  const [availableDevices, setAvailableDevices] = useState(['CPU', 'GPU', 'NPU', 'AUTO'])
  const [extraOptsText, setExtraOptsText] = useState(DEFAULT_OPTS_TEXT_GEN)
  const [extraOptsError, setExtraOptsError] = useState(false)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [selectedModel, setSelectedModel] = useState('')
  const [pipelineFilters, setPipelineFilters] = useState([])
  const [activeFilters, setActiveFilters] = useState(null)
  const [installedModels, setInstalledModels] = useState([])
  const [deleteConfirm, setDeleteConfirm] = useState(null)

  const [chatModel, setChatModel] = useState('')
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatError, setChatError] = useState(null)

  const [benchResults, setBenchResults] = useState({})
  const [benchRunning, setBenchRunning] = useState({})
  const [benchIterations, setBenchIterations] = useState(5)
  const [benchPrompt, setBenchPrompt] = useState('Describe the benefits of AI in one sentence.')
  const [updateInfo, setUpdateInfo] = useState(null)
  const [ovmsUpdateUrl, setOvmsUpdateUrl] = useState(null)
  const chatEndRef = useRef(null)

  const logsEndRef = useRef(null)
  const initLogsEndRef = useRef(null)
  const serverLogsEndRef = useRef(null)
  const startupRan = useRef(false)

  useEffect(() => {
    const offUpdate = EventsOn('update-available', info => setUpdateInfo(info))
    const offOvms = EventsOn('ovms-update-available', url => setOvmsUpdateUrl(url))
    return () => { if (offUpdate) offUpdate(); if (offOvms) offOvms() }
  }, [])

  useEffect(() => {
    const offLog = EventsOn('log', line => {
      setLogs(prev => [...prev, line])
      setInitStep(line)
      const match = Object.entries(PROGRESS_MAP).find(([k]) => line.startsWith(k))
      if (match) setProgress(match[1])
    })
    return () => { if (offLog) offLog() }
  }, [])

  useEffect(() => {
    const offServerLog = EventsOn('server-log', line => {
      setServerLogs(prev => [...prev, line])
    })
    const offServerStatus = EventsOn('server-status', running => {
      setServerRunning(running)
    })
    const offModelsChanged = EventsOn('models-changed', () => {
      loadInstalledModels()
    })
    IsOVMSRunning().then(setServerRunning)
    return () => {
      if (offServerLog) offServerLog()
      if (offServerStatus) offServerStatus()
      if (offModelsChanged) offModelsChanged()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const poll = () => {
      GetOVMSRuntimeStatus()
        .then(s => { if (!cancelled) setOvmsRuntime(s) })
        .catch(() => { if (!cancelled) setOvmsRuntime(prev => ({ ...prev, ready: false })) })
    }
    poll()
    if (!serverRunning) return () => { cancelled = true }
    const id = setInterval(poll, 3000)
    return () => { cancelled = true; clearInterval(id) }
  }, [serverRunning])

  useEffect(() => {
    if (startupRan.current) return
    startupRan.current = true

    GetSystemLanguage().then(lang => {
      console.log('[i18n] detected language:', lang)
      if (lang && lang.toLowerCase().startsWith('zh')) {
        i18n.changeLanguage('zh').then(() => {
          console.log('[i18n] switched to zh')
        })
      }
    }).catch(err => {
      console.error('[i18n] GetSystemLanguage failed:', err)
    })

    Promise.all([GetConfig(), GetStartupEnabled(), GetPipelineFilters()]).then(([cfg, su, filters]) => {
      setConfig(cfg)
      setPipelineFilters(filters || [])
      const enabled = cfg.enabled_categories || ['text']
      const allowed = Object.entries(CATEGORY_GROUPS)
        .filter(([key]) => enabled.includes(key))
        .flatMap(([, g]) => g.types)
        .filter(t => (filters || []).includes(t))
      setActiveFilters(allowed)
      setStartup(su)
    })

    const refreshDevices = () =>
      GetAvailableDevices().then(devices => {
        if (devices && devices.length > 0) setAvailableDevices(devices)
      })

    const autoStart = async () => {
      for (let i = 0; i < 3; i++) {
        try { await StartOVMS(); return } catch {}
        await new Promise(r => setTimeout(r, 1000))
      }
    }

    CheckStatus().then(async s => {
      setStatus(s)
      if (s.deps_ready && s.ovms_ready) {
        refreshDevices()
        autoStart()
        return
      }
      setRunning(true)
      try {
        setInitStep('Setting up OVMS…')
        await PrepareOVMS()
        const s2 = await CheckStatus()
        setStatus(s2)
        setLogs([])
        refreshDevices()
        autoStart()
      } catch (err) {
        setInitError(String(err))
      } finally {
        setRunning(false)
      }
    })
  }, [])

  useEffect(() => {
    if ((tab === 'models' || tab === 'chat' || tab === 'benchmark') && status?.deps_ready && status?.ovms_ready) {
      loadInstalledModels()
    }
  }, [tab, status])

  // Set default target device and extra opts based on selected model pipeline
  useEffect(() => {
    if (!selectedModel) return
    const info = searchResults.find(m => m.id === selectedModel)
    const tag = info?.pipeline_tag
    const clamp = (preferred) => {
      if (availableDevices.length === 0) return preferred
      return availableDevices.includes(preferred) ? preferred : availableDevices[0]
    }
    if (tag === 'text-generation') setTargetDevice(clamp(config.text_gen_target_device || 'GPU'))
    else if (tag === 'feature-extraction' || tag === 'sentence-similarity') setTargetDevice(clamp(config.embeddings_target_device || 'GPU'))
    const isEmbedding = tag === 'feature-extraction' || tag === 'sentence-similarity'
    setExtraOptsText(isEmbedding ? DEFAULT_OPTS_EMBEDDING : DEFAULT_OPTS_TEXT_GEN)
    setExtraOptsError(false)
  }, [selectedModel, searchResults, availableDevices])

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    initLogsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  useEffect(() => {
    serverLogsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [serverLogs])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  const sendChat = async () => {
    const text = chatInput.trim()
    if (!text || !chatModel || chatLoading) return
    const userMsg = { role: 'user', content: text }
    const next = [...chatMessages, userMsg]
    setChatMessages(next)
    setChatInput('')
    setChatError(null)
    setChatLoading(true)
    try {
      const reply = await Chat(chatModel, next)
      setChatMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch (err) {
      setChatError(String(err))
    } finally {
      setChatLoading(false)
    }
  }

  const handleSave = async () => {
    await SaveConfig(config)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const run = (action) => {
    setLogs([])
    setError(null)
    setProgress(0)
    setRunning(true)
    action()
      .then(() => {
        setLogs(prev => [...prev, t('status.done')])
        CheckStatus().then(setStatus)
        loadInstalledModels()
      })
      .catch(err => setError(String(err)))
      .finally(() => setRunning(false))
  }

  const runSetup = async () => {
    setInitError(null)
    setProgress(0)
    setInitStep('Setting up OVMS…')
    setRunning(true)
    try {
      await PrepareOVMS()
      const s2 = await CheckStatus()
      setStatus(s2)
      setLogs([])
    } catch (err) {
      setInitError(String(err))
    } finally {
      setRunning(false)
    }
  }

  const handleReset = async () => {
    if (!window.confirm(t('confirm.reset_ovms'))) return
    setStatus(null)
    setRunning(true)
    try {
      await ResetOVMS()
    } catch (err) {
      setInitError(String(err))
      setRunning(false)
      return
    }
    await runSetup()
  }

  const handleUpdateOVMS = async () => {
    if (!ovmsUpdateUrl) return
    if (!window.confirm(t('confirm.update_ovms'))) return
    setStatus(null)
    setRunning(true)
    try {
      await UpdateOVMSToLatest(ovmsUpdateUrl)
      setOvmsUpdateUrl(null)
    } catch (err) {
      setInitError(String(err))
      setRunning(false)
      return
    }
    await runSetup()
  }

  const handleResetModels = async () => {
    if (!window.confirm(t('confirm.reset_models'))) return
    setRunning(true)
    setError(null)
    try {
      await ResetModels()
      setInstalledModels([])
    } catch (err) {
      setError(String(err))
    } finally {
      setRunning(false)
    }
  }

  const loadInstalledModels = () => {
    GetInstalledModels()
      .then(models => setInstalledModels(models || []))
      .catch(() => setInstalledModels([]))
  }

  const handleDeleteModel = (modelName) => {
    setDeleteConfirm(modelName)
  }

  const confirmDelete = () => {
    const modelName = deleteConfirm
    setDeleteConfirm(null)
    setRunning(true)
    setLogs([t('models.deleting_model', { name: modelName })])
    DeleteInstalledModel(modelName)
      .then(() => {
        setLogs(prev => [...prev, t('models.model_deleted', { name: modelName }), t('status.done')])
        loadInstalledModels()
      })
      .catch(err => setError(String(err)))
      .finally(() => setRunning(false))
  }

  const doSearch = (query) => {
    setSearching(true)
    setSearchResults([])
    setSelectedModel('')
    SearchModels(query, activeFilters || [])
      .then(results => {
        const list = results || []
        setSearchResults(list)
        if (list.length > 0) setSelectedModel(list[0].id)
      })
      .catch(err => setError(String(err)))
      .finally(() => setSearching(false))
  }

  const quickSearch = (tag) => { setSearchQuery(tag); doSearch(tag) }
  const handleSearch = () => { doSearch(searchQuery.trim()) }

  const toggleFilter = (f) =>
    setActiveFilters(prev => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f])

  const selectedModelInfo = searchResults.find(m => m.id === selectedModel)
  const isSelectedOV = selectedModelInfo?.library_name === 'openvino' ||
    selectedModel.toLowerCase().startsWith('openvino/')

  const allReady = status?.deps_ready && status?.ovms_ready

  if (!status || !allReady) {
    return (
      <div className="loading-screen">
        <div className="loading-content">
          <div className="loading-title">{t('app.title')}</div>
          <div className="loading-step">{initStep}</div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="progress-label">{progress > 0 ? `${progress}%` : ''}</div>
          {import.meta.env.DEV && logs.length > 0 && (
            <div className="log-box loading-log">
              {logs.map((line, i) => (
                <div key={i} className={line.startsWith('---') ? 'log-done' : 'log-line'}>{line}</div>
              ))}
              <div ref={initLogsEndRef} />
            </div>
          )}
          {initError && (
            <>
              <div className="error">{initError}</div>
              <button className="btn-primary" style={{ marginTop: 16 }} onClick={runSetup}>
                {t('buttons.retry')}
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">{t('app.title')}</span>
        <nav className="tabs">
          {['server', 'models', 'chat', 'benchmark', 'settings'].map(tabKey => {
            const label = t('tabs.' + tabKey)
            return (
              <button
                key={tabKey}
                className={`tab ${tab === tabKey ? 'active' : ''}`}
                onClick={() => setTab(tabKey)}
              >
                {label}
              </button>
            )
          })}
        </nav>
        <div className="status-row header-status">
          <StatusBadge
            ready={serverRunning && ovmsRuntime.ready}
            label={`OVMS${ovmsRuntime.version ? ' ' + ovmsRuntime.version : ''}`}
            onUpdate={ovmsUpdateUrl ? handleUpdateOVMS : undefined}
          />
          {updateInfo && (
            <button className="status-badge update-badge" onClick={() => BrowserOpenURL(updateInfo.url)} title={updateInfo.release_notes || `Download ${updateInfo.version}`}>
              <span className="status-dot" />{t('status.new_version')}
            </button>
          )}
        </div>
      </header>

      <main className={`tab-content${tab === 'chat' ? ' tab-content--chat' : ''}`}>
        {tab === 'server' && (
          <div className="panel">
            <div className="devices-info">
              <small>{t('server.available_devices', { devices: availableDevices.join(', ') })}</small>
            </div>
            <div className="action-card">
                    <div className="action-card-body">
                      <h3>{t('server.heading')}</h3>
                      <p>{t('server.description', { port: config.ovms_rest_port || 8080 })}</p>
                    </div>
                    <div className="server-controls">
                      {!serverRunning
                        ? (
                          <button className="btn-primary" onClick={() => {
                            setServerLogs([])
                            StartOVMS().catch(err => setServerLogs(prev => [...prev, '--- Error: ' + String(err) + ' ---']))
                          }}>
                            {t('buttons.start_server')}
                          </button>
                        )
                        : (
                          <button className="btn-reset" onClick={() => StopOVMS().catch(() => {})}>
                            {t('buttons.stop_server')}
                          </button>
                        )
                      }
                    </div>
                  </div>

                  {serverLogs.length > 0 && (
                    <div className="log-section">
                      <div className="log-box">
                        {serverLogs.map((line, i) => (
                          <div key={i} className={line.startsWith('---') ? 'log-done' : 'log-line'}>{line}</div>
                        ))}
                        <div ref={serverLogsEndRef} />
                      </div>
                    </div>
                  )}
          </div>
        )}

        {tab === 'models' && (
          <div className="panel">
            <div className="devices-info">
              <small>{t('server.available_devices', { devices: availableDevices.join(', ') })}</small>
            </div>
            <>
              {installedModels.length > 0 && (
                    <div className="installed-models-section">
                      <h3>{t('models.available_models')}</h3>
                      <div className="installed-models-list">
                        {installedModels.map(model => (
                          <div key={model.name} className="installed-model-card">
                            <div className="installed-model-info">
                              <div className="installed-model-name">{model.name}</div>
                              <div className="installed-model-device">
                                <span className="device-label">{t('models.target_device')}</span>
                                <span className="device-value">{model.target_device}</span>
                              </div>
                              {model.task && (
                                <div className="installed-model-device">
                                  <span className="device-label">{t('models.type')}</span>
                                  <span className="device-value">{model.task}</span>
                                </div>
                              )}
                            </div>
                            <button
                              className="btn-delete-model"
                              disabled={running}
                              onClick={() => handleDeleteModel(model.name)}
                              title={t('models.delete_model_tooltip')}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                              </svg>
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="search-section">
                    <h3>{t('models.huggingface_models')}</h3>
                    {(config.search_tags || []).length > 0 && (
                      <div className="filter-group">
                        <span className="filter-label">{t('models.quick_search')}</span>
                        <div className="search-tags">
                          {(config.search_tags || []).map(tag => (
                            <button key={tag} className="search-tag" onClick={() => quickSearch(tag)}>{tag}</button>
                          ))}
                        </div>
                      </div>
                    )}
                    {pipelineFilters.length > 0 && (() => {
                      const enabled = config.enabled_categories || ['text']
                      const groups = Object.entries(CATEGORY_GROUPS)
                        .filter(([key]) => enabled.includes(key))
                        .map(([key, g]) => ({ key, label: g.label, types: g.types.filter(t => pipelineFilters.includes(t)) }))
                        .filter(g => g.types.length > 0)
                      if (groups.length === 0) return null
                      return (
                      <div className="filter-group">
                        <span className="filter-label">{t('models.filter_by_type')}</span>
                          <div className="filter-chips-grouped">
                            {groups.map(g => (
                              <div key={g.key} className="filter-chip-group">
                                <span className="filter-chip-group-label">{g.label}</span>
                                <div className="filter-chips">
                                  {g.types.map(f => {
                                    const active = (activeFilters || []).includes(f)
                                    return (
                                      <button
                                        key={f}
                                        className={`filter-chip ${active ? 'active' : ''}`}
                                        onClick={() => toggleFilter(f)}
                                      >
                                        {f}
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })()}
                    <div className="search-row">
                      <input
                        className="search-input"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleSearch()}
                        placeholder={t('models.search_placeholder')}
                      />
                      <button className="btn-primary" disabled={searching} onClick={handleSearch}>
                        {searching ? t('buttons.searching') : t('buttons.search')}
                      </button>
                    </div>

                    {searchResults.length > 0 && (
                      <div className="search-results">
                        <select
                          size={Math.min(Math.max(searchResults.length, 2), 8)}
                          value={selectedModel}
                          onChange={e => setSelectedModel(e.target.value)}
                        >
                          {searchResults.map(m => (
                            <option key={m.id} value={m.id}>
                              {m.id}{m.pipeline_tag ? ` · ${m.pipeline_tag}` : ''} · ↓{m.downloads.toLocaleString()}
                            </option>
                          ))}
                        </select>

                        {selectedModel && (
                          <div className="export-opts">
                            <label>{t('models.target_device_label')}
                              <select value={targetDevice} onChange={e => setTargetDevice(e.target.value)}>
                                {availableDevices.map(d => <option key={d}>{d}</option>)}
                              </select>
                            </label>
                            {!isSelectedOV && (
                              <label style={{marginTop: 10}}>{t('models.extra_options')}
                                <textarea
                                  className={`opts-raw-editor${extraOptsError ? ' opts-editor-error' : ''}`}
                                  value={extraOptsText}
                                  spellCheck={false}
                                  onChange={e => {
                                    setExtraOptsText(e.target.value)
                                    try { JSON.parse(e.target.value); setExtraOptsError(false) }
                                    catch { setExtraOptsError(true) }
                                  }}
                                />
                                {extraOptsError && <div className="opts-editor-error-msg">{t('models.invalid_json')}</div>}
                                <div className="opts-presets">
                                  {[
                                    { label: t('presets.parsers'), values: { tool_parser: 'hermes3', reasoning_parser: 'qwen3' } },
                                    { label: t('presets.kv_cache'), values: { kv_cache_precision: 'u8' } },
                                    { label: t('presets.batching'), values: { max_num_batched_tokens: 4096, max_num_seqs: 256 } },
                                  ].map(preset => (
                                    <button
                                      key={preset.label}
                                      type="button"
                                      className="opts-preset-btn"
                                      onClick={() => {
                                        try {
                                          const current = JSON.parse(extraOptsText || '{}')
                                          const merged = { ...current, ...preset.values }
                                          setExtraOptsText(JSON.stringify(merged, null, 2))
                                          setExtraOptsError(false)
                                        } catch { setExtraOptsError(true) }
                                      }}
                                    >+ {preset.label}</button>
                                  ))}
                                  <a
                                    className="opts-docs-link"
                                    onClick={() => BrowserOpenURL('https://docs.openvino.ai/2026/model-server/ovms_docs_parameters.html')}
                                  >{t('buttons.all_options')}</a>
                                </div>
                              </label>
                            )}
                          </div>
                        )}

                        <div className="search-actions">
                          <button
                            className="btn-primary"
                            disabled={running || !selectedModel || extraOptsError || (!isSelectedOV && !pipelineFilters.includes(selectedModelInfo?.pipeline_tag))}
                            onClick={() => {
                              if (isSelectedOV) {
                                run(() => PullModel(selectedModel, targetDevice, selectedModelInfo?.pipeline_tag ?? ''))
                              } else {
                                const extraOpts = (() => { try { return JSON.parse(extraOptsText) } catch { return {} } })()
                                const tag = selectedModelInfo?.pipeline_tag
                                if (tag === 'text-generation' || tag === 'image-text-to-text') run(() => ExportTextGen(selectedModel, targetDevice, extraOpts))
                                else if (tag === 'feature-extraction' || tag === 'sentence-similarity') run(() => ExportEmbeddings(selectedModel, targetDevice, extraOpts))
                              }
                            }}
                          >
                            {running ? t('buttons.running') : isSelectedOV ? t('buttons.pull') : t('buttons.export')}
                          </button>
                          {selectedModel && !isSelectedOV && !pipelineFilters.includes(selectedModelInfo?.pipeline_tag) && (
                            <span className="unsupported-model-msg">
                              {t('models.unsupported_model_type', { type: selectedModelInfo?.pipeline_tag || 'unknown' })}
                            </span>
                          )}
                          {selectedModel && (
                            <button
                              className="btn-hf-link"
                              onClick={() => BrowserOpenURL(`https://huggingface.co/${selectedModel}`)}
                            >
                              {t('buttons.view_on_huggingface')}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="log-section">
                    {error && <div className="error">{error}</div>}
                    <div className="log-box">
                      {logs.length === 0 && !error
                        ? <div className="log-line log-empty">{t('models.export_output_placeholder')}</div>
                        : logs.map((line, i) => (
                          <div key={i} className={line.startsWith('---') ? 'log-done' : 'log-line'}>{line}</div>
                        ))
                      }
                      <div ref={logsEndRef} />
                    </div>
                  </div>
            </>
          </div>
        )}

        {tab === 'chat' && (() => {
          const textGenModels = installedModels.filter(m => m.task === 'text-generation' || m.task === 'image-text-to-text')
          const chatDisabled = !serverRunning || textGenModels.length === 0

          return (
            <div className="chat-panel">
              {!serverRunning && (
                <div className="chat-notice chat-notice--warn">
                  <span dangerouslySetInnerHTML={{ __html: t('chat.server_not_running') }} />
                </div>
              )}
              {serverRunning && textGenModels.length === 0 && (
                <div className="chat-notice chat-notice--warn">
                  <span dangerouslySetInnerHTML={{ __html: t('chat.no_text_gen_models') }} />
                </div>
              )}

              <div className="chat-toolbar">
                <select
                  className="chat-model-select"
                  value={chatModel}
                  disabled={chatDisabled}
                  onChange={e => { setChatModel(e.target.value); setChatMessages([]); setChatError(null) }}
                >
                  {chatModel === '' && <option value="">{t('chat.select_model')}</option>}
                  {textGenModels.map(m => (
                    <option key={m.name} value={m.name}>{m.name}</option>
                  ))}
                </select>
                {chatMessages.length > 0 && (
                  <button className="btn-ghost" onClick={() => { setChatMessages([]); setChatError(null) }}>
                    {t('buttons.clear')}
                  </button>
                )}
              </div>

              <div className="chat-messages">
                {!chatDisabled && chatMessages.length === 0 && !chatError && (
                  <div className="chat-empty">
                    {chatModel ? t('chat.empty_ready') : t('chat.empty_no_model')}
                  </div>
                )}
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`chat-bubble chat-bubble--${msg.role}`}>
                    <div className="chat-bubble-role">{msg.role === 'user' ? t('chat.role_user') : t('chat.role_assistant')}</div>
                    <div className="chat-bubble-content">{msg.content}</div>
                  </div>
                ))}
                {chatLoading && (
                  <div className="chat-bubble chat-bubble--assistant">
                    <div className="chat-bubble-role">{t('chat.role_assistant')}</div>
                    <div className="chat-typing"><span /><span /><span /></div>
                  </div>
                )}
                {chatError && <div className="error" style={{ margin: '8px 0' }}>{chatError}</div>}
                <div ref={chatEndRef} />
              </div>

              <div className="chat-input-row">
                <textarea
                  className="chat-input"
                  placeholder={
                    !serverRunning ? t('chat.placeholder_server_off') :
                    textGenModels.length === 0 ? t('chat.placeholder_no_models') :
                    chatModel ? t('chat.placeholder_type_message') : t('chat.placeholder_select_model')
                  }
                  disabled={chatDisabled || !chatModel || chatLoading}
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() }
                  }}
                  rows={2}
                />
                <button
                  className="btn-primary chat-send-btn"
                  disabled={chatDisabled || !chatModel || !chatInput.trim() || chatLoading}
                  onClick={sendChat}
                >
                  {chatLoading ? '…' : t('buttons.send')}
                </button>
              </div>
            </div>
          )
        })()}

        {tab === 'benchmark' && (
          <div className="panel">
            {!serverRunning && (
              <div className="chat-notice chat-notice--warn">
                <span dangerouslySetInnerHTML={{ __html: t('benchmark.server_not_running') }} />
              </div>
            )}

            <div className="bench-config">
              <div className="bench-config-row">
                <label>{t('benchmark.iterations')} <span className="bench-iter-val">{benchIterations}</span></label>
                <input
                  type="range" min={1} max={20} value={benchIterations}
                  onChange={e => setBenchIterations(parseInt(e.target.value))}
                  className="bench-slider"
                />
              </div>
              <div className="bench-config-row">
                <label>{t('benchmark.prompt')}</label>
                <textarea
                  className="bench-prompt"
                  value={benchPrompt}
                  onChange={e => setBenchPrompt(e.target.value)}
                  rows={2}
                />
              </div>
            </div>

            {(() => {
              const benchModels = installedModels.filter(m => m.task === 'text-generation' || m.task === 'image-text-to-text')
              if (benchModels.length === 0) return (
                <div className="empty-state">{t('benchmark.no_models')}</div>
              )
              return (
              <div className="bench-table-wrap">
                <table className="bench-table">
                  <thead>
                    <tr>
                      <th>{t('benchmark.col_model')}</th>
                      <th>{t('benchmark.col_task')}</th>
                      <th>{t('benchmark.col_device')}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {benchModels.map(model => {
                      const isRunning = !!benchRunning[model.name]
                      const result = benchResults[model.name]
                      return (
                        <>
                          <tr key={model.name}>
                            <td className="bench-model-name">{model.name}</td>
                            <td><span className="bench-task-badge">{model.task || '—'}</span></td>
                            <td className="bench-device">{model.target_device}</td>
                            <td>
                              <button
                                className="btn-primary bench-run-btn"
                                disabled={isRunning || !serverRunning}
                                onClick={async () => {
                                  setBenchRunning(prev => ({ ...prev, [model.name]: true }))
                                  try {
                                    const r = await RunBenchmark(model.name, model.task || '', benchIterations, benchPrompt)
                                    setBenchResults(prev => ({ ...prev, [model.name]: r }))
                                  } finally {
                                    setBenchRunning(prev => ({ ...prev, [model.name]: false }))
                                  }
                                }}
                              >
                                {isRunning ? t('buttons.running') : result ? t('buttons.re_run') : t('buttons.run')}
                              </button>
                            </td>
                          </tr>
                          {result && (
                            <tr key={model.name + '-result'} className="bench-result-row">
                              <td colSpan={4}>
                                {result.error ? (
                                  <div className="error">{result.error}</div>
                                ) : (
                                  <div className="bench-result">
                                  <div className="bench-stats">
                                    <div className="bench-stat">
                                      <span className="bench-stat-label">{t('benchmark.stat_min')}</span>
                                      <span className="bench-stat-value">{result.min_latency_ms.toFixed(0)} {t('benchmark.unit_ms')}</span>
                                    </div>
                                    <div className="bench-stat">
                                      <span className="bench-stat-label">{t('benchmark.stat_avg')}</span>
                                      <span className="bench-stat-value bench-stat-avg">{result.avg_latency_ms.toFixed(0)} {t('benchmark.unit_ms')}</span>
                                    </div>
                                    <div className="bench-stat">
                                      <span className="bench-stat-label">{t('benchmark.stat_p95')}</span>
                                      <span className="bench-stat-value bench-stat-p95">{result.p95_latency_ms.toFixed(0)} {t('benchmark.unit_ms')}</span>
                                    </div>
                                    <div className="bench-stat">
                                      <span className="bench-stat-label">{t('benchmark.stat_max')}</span>
                                      <span className="bench-stat-value">{result.max_latency_ms.toFixed(0)} {t('benchmark.unit_ms')}</span>
                                    </div>
                                    <div className="bench-stat">
                                      <span className="bench-stat-label">{t('benchmark.stat_throughput')}</span>
                                      <span className="bench-stat-value">{result.throughput_rps.toFixed(2)} {t('benchmark.unit_rps')}</span>
                                    </div>
                                  </div>
                                    <LatencyChart latencies={result.latencies} avg={result.avg_latency_ms} p95={result.p95_latency_ms} />
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              )
            })()}
          </div>
        )}

        {tab === 'settings' && (
          <div className="panel">
            <div className="fields">
              <div className="field">
                <label>{t('settings.setup_folder')}</label>
                <input
                  value={config.install_dir}
                  onChange={e => setConfig(c => ({ ...c, install_dir: e.target.value }))}
                  placeholder={t('settings.setup_folder_placeholder')}
                />
                <small>{t('settings.setup_folder_help')}</small>
              </div>

              <div className="field">
                <label>{t('settings.ovms_download_url')}</label>
                <input
                  value={config.ovms_url}
                  onChange={e => setConfig(c => ({ ...c, ovms_url: e.target.value }))}
                  placeholder={t('settings.ovms_download_url_placeholder')}
                />
                <small>{t('settings.ovms_download_url_help')}</small>
              </div>

              <div className="field">
                <label>{t('settings.uv_download_url')}</label>
                <input
                  value={config.uv_url}
                  onChange={e => setConfig(c => ({ ...c, uv_url: e.target.value }))}
                  placeholder={t('settings.uv_download_url_placeholder')}
                />
                <small>{t('settings.uv_download_url_help')}</small>
              </div>

              <div className="field">
                <label>{t('settings.rest_api_port')}</label>
                <input
                  type="number"
                  min="1024"
                  max="65535"
                  value={config.api_port}
                  onChange={e => setConfig(c => ({ ...c, api_port: parseInt(e.target.value) || 3333 }))}
                />
                <small>{t('settings.rest_api_port_help')}</small>
              </div>

              <div className="field">
                <label>{t('settings.ovms_rest_port')}</label>
                <input
                  type="number"
                  min="1024"
                  max="65535"
                  value={config.ovms_rest_port}
                  onChange={e => setConfig(c => ({ ...c, ovms_rest_port: parseInt(e.target.value) || 8080 }))}
                />
                <small>{t('settings.ovms_rest_port_help')}</small>
              </div>

              <div className="field">
                <label>{t('settings.log_level')}</label>
                <select
                  value={config.log_level || 'INFO'}
                  onChange={e => setConfig(c => ({ ...c, log_level: e.target.value }))}
                >
                  <option value="DEBUG">{t('settings.log_level_debug')}</option>
                  <option value="INFO">{t('settings.log_level_info')}</option>
                  <option value="WARNING">{t('settings.log_level_warning')}</option>
                  <option value="ERROR">{t('settings.log_level_error')}</option>
                </select>
                <small>{t('settings.log_level_help')}</small>
              </div>

            </div>

            <div className="field">
              <label>{t('settings.search_limit')}</label>
              <input
                type="number"
                min="1"
                max="200"
                value={config.search_limit || 30}
                onChange={e => setConfig(c => ({ ...c, search_limit: parseInt(e.target.value) || 30 }))}
              />
              <small>{t('settings.search_limit_help')}</small>
            </div>

            <div className="field">
              <label>{t('settings.model_categories')}</label>
              <div className="category-toggles">
                {Object.entries(CATEGORY_GROUPS).map(([key, g]) => {
                  const checked = (config.enabled_categories || ['text']).includes(key)
                  return (
                    <label key={key} className="toggle-inline">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={e => {
                          const next = e.target.checked
                            ? [...(config.enabled_categories || []), key]
                            : (config.enabled_categories || []).filter(c => c !== key)
                          setConfig(c => ({ ...c, enabled_categories: next }))
                          const allowed = Object.entries(CATEGORY_GROUPS)
                            .filter(([k]) => next.includes(k))
                            .flatMap(([, grp]) => grp.types)
                            .filter(t => pipelineFilters.includes(t))
                          setActiveFilters(allowed)
                        }}
                      />
                      {key === 'text' ? t('models.category_text') : t('models.category_embeddings')}
                    </label>
                  )
                })}
              </div>
              <small>{t('settings.model_categories_help')}</small>
            </div>

            <div className="field">
              <label>{t('settings.search_tags')}</label>
              <div className="tag-editor">
                {(config.search_tags || []).map(tag => (
                  <span key={tag} className="tag-pill">
                    {tag}
                    <button onClick={() => setConfig(c => ({ ...c, search_tags: c.search_tags.filter(t => t !== tag) }))}>×</button>
                  </span>
                ))}
                <input
                  className="tag-input"
                  value={newTag}
                  onChange={e => setNewTag(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newTag.trim()) {
                      setConfig(c => ({ ...c, search_tags: [...(c.search_tags || []), newTag.trim()] }))
                      setNewTag('')
                    }
                  }}
                  placeholder={t('settings.search_tags_placeholder')}
                />
              </div>
              <small>{t('settings.search_tags_help')}</small>
            </div>

            <label className="toggle-row">
              <span className="toggle-label">
                {t('settings.run_on_startup')}
                <small>{t('settings.run_on_startup_help')}</small>
              </span>
              <input
                type="checkbox"
                checked={startup}
                onChange={e => {
                  const next = e.target.checked
                  SetStartup(next).then(() => setStartup(next))
                }}
              />
            </label>

            <div className="reset-row">
              <button className="btn-reset" disabled={running} onClick={handleResetModels}>
                {t('buttons.reset_models')}
              </button>
              <button className="btn-reset" disabled={running} onClick={handleReset}>
                {t('buttons.reset_ovms')}
              </button>
            </div>

            <button className="btn-save" onClick={handleSave}>
              {saved ? t('buttons.saved') : t('buttons.save_settings')}
            </button>
          </div>
        )}
      </main>

      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal-content modal-confirm" onClick={e => e.stopPropagation()}>
            <h3>{t('confirm.delete_model_title')}</h3>
            <div className="modal-body">
              <p className="modal-confirm-text">
                <span dangerouslySetInnerHTML={{ __html: t('confirm.delete_model_question', { name: deleteConfirm }) }} />
              </p>
              <p className="modal-confirm-warning">
                {t('confirm.delete_model_warning')}
              </p>
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setDeleteConfirm(null)}>{t('buttons.cancel')}</button>
              <button className="btn-delete" onClick={confirmDelete}>{t('buttons.delete')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
