import { useEffect, useRef, useState } from 'react'
import { Chat, Globe, Lock, Plus, Users } from '@openai/apps-sdk-ui/components/Icon'
import { CSS } from './theme.js'
import { LANDING_DATA_URL } from './ui/landingImage.js'
import * as api from './api.js'
import Board, { Avatar } from './ui/Board.jsx'
import Messages from './ui/Messages.jsx'
import Thread from './ui/Thread.jsx'
import GroupThread from './ui/GroupThread.jsx'
import People from './ui/People.jsx'
import { Lightbox } from './ui/Media.jsx'

export default function App({ appId, token }) {
  api.setToken(token)

  const [me, setMe] = useState(null)
  const [meState, setMeState] = useState('loading')
  const [tab, setTab] = useState('board')
  const [feed, setFeed] = useState([])
  const [feedState, setFeedState] = useState('loading')
  const [conversations, setConversations] = useState([])
  const [groups, setGroups] = useState([])
  const [thread, setThread] = useState(null) // { kind: 'dm'|'group', peer?, name?, group? }
  const [version, setVersion] = useState(0)
  const [toast, setToast] = useState(null)
  const [lightbox, setLightbox] = useState(null)
  const [profileRequest, setProfileRequest] = useState(null)
  const [composing, setComposing] = useState(false)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [appIconUrl, setAppIconUrl] = useState(null)
  const navHandle = useRef(null)
  const toastTimer = useRef(null)
  const readySignalled = useRef(false)

  function showToast(text, kind) {
    setToast({ text, kind })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }

  async function loadMe() {
    try {
      const profile = await api.getMe()
      setMe(profile)
      setMeState(profile.joined && profile.name ? 'ready' : 'setup')
    } catch (error) {
      window.mobius?.signal?.('error', { message: error.message, source: 'me' })
      setMeState('error')
    }
  }

  async function loadFeed() {
    try {
      const result = await api.getFeed()
      setFeed(result.posts || [])
      setFeedState('ready')
    } catch {
      setFeedState('error')
    }
  }

  async function loadConversations() {
    try {
      const [loaded, loadedGroups] = await Promise.all([
        api.listConversations(), api.listGroups(),
      ])
      setConversations(loaded)
      setGroups(loadedGroups)
      if (!readySignalled.current) {
        readySignalled.current = true
        window.mobius?.signal?.('app_ready', {
          item_count: loaded.length + loadedGroups.length,
        })
      }
    } catch { /* storage unavailable — views show empty states */ }
  }

  useEffect(() => {
    loadMe()
    loadFeed()
    loadConversations()
    api.getAppIcon(appId)
      .then((blob) => setAppIconUrl(URL.createObjectURL(blob)))
      .catch(() => {})
  }, [])

  // Incoming federation deliveries bump state/version.json on the server.
  // Poll it while visible (get() revalidates in the background and notifies
  // the subscriber below when the server value changed).
  useEffect(() => {
    const store = window.mobius?.storage
    if (!store) return
    let unsubscribe = null
    let cancelled = false
    store
      .subscribe('state/version.json', (value) => {
        if (cancelled || !value) return
        setVersion((prior) => (value.v !== prior ? value.v : prior))
      })
      .then?.((u) => { if (typeof u === 'function') unsubscribe = u })
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') {
        store.get('state/version.json').catch(() => null)
      }
    }, 5000)
    return () => {
      cancelled = true
      clearInterval(poll)
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (version > 0) loadConversations()
  }, [version])

  // ── thread navigation with a real shell back target ───────────────────────
  function openAnyThread(next) {
    navHandle.current?.close()
    let handle = null
    handle = window.mobius?.nav?.open?.('common-thread', {
      onBack: () => { navHandle.current = null; setThread(null); loadConversations() },
      onForward: () => { navHandle.current = handle; setThread(next) },
    })
    navHandle.current = handle || null
    setTab('messages')
    setThread(next)
  }

  const openThread = (peer, name) => openAnyThread({ kind: 'dm', peer, name })
  const openGroup = (group) => openAnyThread({ kind: 'group', group })

  async function openCreatedGroup(gid) {
    await loadConversations()
    const created = (await api.listGroups()).find((g) => g.gid === gid)
    if (created) openGroup(created)
  }

  function closeThread() {
    navHandle.current?.close()
    navHandle.current = null
    setThread(null)
    loadConversations()
  }

  // ── onboarding: join with the shared Möbius identity ──────────────────────
  const [saving, setSaving] = useState(false)

  function openIdentityApp() {
    if (me?.identity_app_id) {
      window.parent.postMessage({ type: 'moebius:open-app', appId: me.identity_app_id }, '*')
    }
  }

  async function join() {
    setSaving(true)
    try {
      const result = await api.join()
      await loadMe()
      loadFeed()
      if (result.directory !== 'registered') {
        showToast('Joined — your community host is unreachable right now.', 'error')
      } else {
        showToast('Welcome to Social', 'success')
      }
    } catch (error) {
      showToast(error.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const unread =
    conversations.reduce((sum, c) => sum + (c.unread || 0), 0) +
    groups.reduce((sum, g) => sum + (g.unread || 0), 0)

  // ── render ────────────────────────────────────────────────────────────────
  if (meState === 'loading') {
    return (
      <div className="cn-root"><style>{CSS}</style>
        <div className="cn-center" style={{ flex: 1 }}><div className="cn-spinner" /></div>
      </div>
    )
  }

  if (meState === 'error') {
    return (
      <div className="cn-root"><style>{CSS}</style>
        <div className="cn-empty" style={{ margin: 'auto' }}>
          <div className="cn-empty-title">Social needs its server side</div>
          <p className="cn-empty-text">
            The federation service isn’t active on this Möbius yet. It switches on
            with the next server restart — then reopen this app.
          </p>
          <button className="cn-btn cn-btn-secondary" onClick={loadMe}>Try again</button>
        </div>
      </div>
    )
  }

  if (meState === 'setup') {
    const connected = me?.connected
    return (
      <div className="cn-root"><style>{CSS}</style>
        <div className="cn-scroll">
          <div className="cn-onboard cn-screen">
            {LANDING_DATA_URL
              ? <img className="cn-landing" src={LANDING_DATA_URL} alt="" />
              : <Avatar name={connected ? me.handle : '?'} host={me?.host || 'you'} size="large" />}
            <h2>Welcome to Social</h2>
            <p>
              Your Möbius is your identity here. Messages travel directly from
              your server to your friends’ servers — your words live only with
              you and the people you talk to. The board and people search are
              shared through a community host you choose.
            </p>
            {connected ? (
              <>
                <div className="cn-identity-card">
                  <Avatar name={me.handle} host={me.host} />
                  <span style={{ minWidth: 0, textAlign: 'left' }}>
                    <span className="cn-person-name" style={{ display: 'block' }}>@{me.handle}</span>
                  </span>
                </div>
                <div className="cn-privacy-note">
                  <Lock aria-hidden="true" />
                  <span>
                    Your handle <strong>@{me.handle}</strong> and profile picture are shared.
                    Your name and email never leave your Möbius. Direct messages are
                    end-to-end encrypted when both sides support it.
                  </span>
                </div>
                <button className="cn-btn cn-btn-primary cn-btn-block" style={{ marginTop: 18 }}
                        onClick={join} disabled={saving}>
                  {saving ? 'Joining…' : `Join as @${me.handle}`}
                </button>
              </>
            ) : (
              <>
                <p>
                  Social uses your Möbius profile, so friends recognize you
                  everywhere. Connect your account first — it takes a minute.
                </p>
                {me?.account_error && (
                  <p style={{ color: 'var(--danger)', fontSize: 13 }}>{me.account_error}</p>
                )}
                <button className="cn-btn cn-btn-primary cn-btn-block" style={{ marginTop: 6 }}
                        onClick={openIdentityApp} disabled={!me?.identity_app_id}>
                  Connect your Möbius profile
                </button>
                <button className="cn-btn cn-btn-ghost cn-btn-block" style={{ marginTop: 8 }}
                        onClick={loadMe}>
                  I’ve connected it — check again
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (thread) {
    return (
      <div className="cn-root"><style>{CSS}</style>
        {thread.kind === 'group' ? (
          <GroupThread
            group={groups.find((g) => g.gid === thread.group.gid) || thread.group}
            me={me}
            version={version}
            onBack={closeThread}
            showToast={showToast}
            onOpenImage={(url, alt) => setLightbox({ url, alt })}
          />
        ) : (
          <Thread
            peer={thread.peer}
            peerHandle={thread.name || conversations.find((c) => c.peer === thread.peer)?.peer_handle}
            me={me}
            version={version}
            onBack={closeThread}
            showToast={showToast}
            onOpenImage={(url, alt) => setLightbox({ url, alt })}
          />
        )}
        {toast && <div className={`cn-toast${toast.kind ? ` is-${toast.kind}` : ''}`} role="status">{toast.text}</div>}
        <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
      </div>
    )
  }

  return (
    <div className="cn-root">
      <style>{CSS}</style>
      <header className="cn-header">
        <div className="cn-brand">
          {appIconUrl
            ? <img className="cn-app-icon" src={appIconUrl} alt="" draggable="false" />
            : <span className="cn-mark" aria-hidden="true"><span className="cn-mark-orbit" /></span>}
          <h1 className="cn-title">Social</h1>
        </div>
        <div className="cn-header-chip">
          <Avatar name={me?.handle} host={me?.host} size="small" />
          <span>@{me?.handle}</span>
        </div>
      </header>

      <div className="cn-scroll">
        {tab === 'board' && (
          <Board me={me} feed={feed} feedState={feedState} onRefresh={loadFeed}
                 composing={composing} setComposing={setComposing}
                 onOpenPerson={(host) => { setProfileRequest(host); setTab('people') }} showToast={showToast}
                 onOpenImage={(url, alt) => setLightbox({ url, alt })} />
        )}
        {tab === 'messages' && (
          <Messages me={me} conversations={conversations} groups={groups}
                    creating={creatingGroup} setCreating={setCreatingGroup}
                    onOpenThread={(peer) => openThread(peer)}
                    onOpenGroup={openGroup}
                    onFindPeople={() => setTab('people')}
                    onGroupsChanged={openCreatedGroup}
                    showToast={showToast} />
        )}
        {tab === 'people' && (
          <People me={me} onMessage={(host, name) => openThread(host, name)} showToast={showToast}
                  requestedProfile={profileRequest}
                  onProfileRequestHandled={() => setProfileRequest(null)} />
        )}
      </div>

      {tab === 'board' && (
        <button className="cn-fab" onClick={() => setComposing(true)} aria-label="New post">
          <Plus aria-hidden="true" />
        </button>
      )}
      {tab === 'messages' && (
        <button className="cn-fab" onClick={() => setCreatingGroup(true)} aria-label="New group">
          <Plus aria-hidden="true" />
        </button>
      )}

      <nav className="cn-nav" aria-label="Main navigation">
        <button className={`cn-nav-item${tab === 'board' ? ' is-active' : ''}`} onClick={() => setTab('board')}>
          <Globe aria-hidden="true" /><span>Board</span>
        </button>
        <button className={`cn-nav-item${tab === 'messages' ? ' is-active' : ''}`} onClick={() => setTab('messages')}>
          {unread > 0 && <span className="cn-badge">{unread}</span>}
          <Chat aria-hidden="true" /><span>Messages</span>
        </button>
        <button className={`cn-nav-item${tab === 'people' ? ' is-active' : ''}`} onClick={() => setTab('people')}>
          <Users aria-hidden="true" /><span>People</span>
        </button>
      </nav>

      {toast && <div className={`cn-toast${toast.kind ? ` is-${toast.kind}` : ''}`} role="status">{toast.text}</div>}
      <Lightbox image={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}
