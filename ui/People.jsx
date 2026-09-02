import { useEffect, useRef, useState } from 'react'
import { Search, Telescope } from '@openai/apps-sdk-ui/components/Icon'
import { searchPeople, getPeer } from '../api.js'
import { Avatar } from './Board.jsx'

const monthYear = new Intl.DateTimeFormat(undefined, {
  month: 'short', year: 'numeric', timeZone: 'UTC',
})

function formatMonthYear(value, unixSeconds = false) {
  if (value === null || value === undefined || value === '') return ''
  const date = unixSeconds ? new Date(Number(value) * 1000) : new Date(value)
  return Number.isNaN(date.getTime()) ? '' : monthYear.format(date)
}

function tenureLine(profile) {
  const memberSince = formatMonthYear(profile.member_since)
  const joinedSocial = formatMonthYear(profile.joined_at, true)
  if (memberSince && joinedSocial) {
    return `On Möbius since ${memberSince} · joined Social ${joinedSocial}`
  }
  if (memberSince) return `On Möbius since ${memberSince}`
  if (joinedSocial) return `Joined Social ${joinedSocial}`
  return ''
}

function appInitial(name) {
  return Array.from(String(name || '').trim())[0]?.toLocaleUpperCase() || 'A'
}

export default function People({ me, onMessage, showToast, requestedProfile, onProfileRequestHandled }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [state, setState] = useState('loading')
  const [profile, setProfile] = useState(null)
  const [profileState, setProfileState] = useState('idle')
  const debounce = useRef(null)

  async function runSearch(q) {
    try {
      const found = await searchPeople(q)
      setResults(found.users)
      setState('ready')
    } catch (error) {
      window.mobius?.signal?.('error', { message: error.message, source: 'people' })
      setState('error')
    }
  }

  useEffect(() => {
    runSearch('')
  }, [])

  useEffect(() => {
    if (requestedProfile) {
      openProfile(requestedProfile)
      onProfileRequestHandled?.()
    }
  }, [requestedProfile])

  function onQuery(value) {
    setQuery(value)
    clearTimeout(debounce.current)
    debounce.current = setTimeout(() => runSearch(value), 250)
  }

  async function openProfile(host) {
    setProfileState('loading')
    setProfile({ host })
    try {
      const actor = await getPeer(host)
      setProfile(actor)
      setProfileState('ready')
    } catch (error) {
      setProfile({ host, error: error.message })
      setProfileState('error')
    }
  }

  const profileTenure = profileState === 'ready' ? tenureLine(profile) : ''
  const profileApps = profileState === 'ready' && Array.isArray(profile.apps)
    ? profile.apps
      .map((app) => ({
        name: String(app?.name || '').trim(),
        description: String(app?.description || '').trim(),
      }))
      .filter((app) => app.name)
    : []

  return (
    <div className="cn-content cn-screen">
      <label className="cn-search">
        <Search aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search people by handle"
          aria-label="Search people"
        />
      </label>

      {state === 'loading' && <div className="cn-center"><div className="cn-spinner" /></div>}
      {state === 'error' && (
        <div className="cn-empty">
          <div className="cn-empty-title">Directory unavailable</div>
          <p className="cn-empty-text">Your community host couldn’t be reached right now.</p>
          <button className="cn-btn cn-btn-secondary" onClick={() => runSearch(query)}>Try again</button>
        </div>
      )}

      <div className="cn-people-list">
        {(results || []).map((user) => (
          <button className="cn-row" key={user.host} onClick={() => openProfile(user.host)}>
            <Avatar name={user.handle} host={user.host} />
            <span className="cn-row-copy">
              <span className="cn-row-top">
                <strong>{user.handle ? `@${user.handle}` : 'Social member'}{user.host === me?.host ? ' (you)' : ''}</strong>
              </span>
              {user.bio ? <span className="cn-preview">{user.bio}</span> : null}
            </span>
          </button>
        ))}
        {state === 'ready' && (results || []).length === 0 && (
          <div className="cn-empty">
            <div className="cn-empty-mark" aria-hidden="true"><Telescope /></div>
            <div className="cn-empty-title">No one found</div>
            <p className="cn-empty-text">
              Try a different name or handle.
            </p>
          </div>
        )}
      </div>

      {profile && (
        <div className="cn-scrim" role="dialog" aria-modal="true" aria-label="Profile"
             onClick={() => setProfile(null)}>
          <div className="cn-sheet" onClick={(e) => e.stopPropagation()}>
            {profileState === 'loading' && <div className="cn-center"><div className="cn-spinner" /></div>}
            {profileState === 'error' && (
              <>
                <h3 className="cn-sheet-title">Profile unavailable</h3>
                <p className="cn-sheet-body">
                  This person couldn’t be reached. They may be offline right now.
                </p>
                <div className="cn-sheet-actions">
                  <button className="cn-btn cn-btn-secondary" onClick={() => setProfile(null)}>Close</button>
                </div>
              </>
            )}
            {profileState === 'ready' && (
              <>
                <div className="cn-profile-head">
                  <Avatar name={profile.handle} host={profile.host} size="large" />
                  <div className="cn-profile-copy">
                    <h3 className="cn-profile-name">{profile.handle ? `@${profile.handle}` : 'Social member'}</h3>
                    {profile.bio && <p className="cn-bio">{profile.bio}</p>}
                    {profileTenure && <p className="cn-profile-tenure">{profileTenure}</p>}
                  </div>
                </div>
                {profileApps.length > 0 && (
                  <section className="cn-profile-apps" aria-labelledby="cn-profile-apps-title">
                    <h4 className="cn-profile-section-title" id="cn-profile-apps-title">Apps</h4>
                    <div className="cn-profile-app-list">
                      {profileApps.map((app, index) => (
                        <div className="cn-profile-app-row" key={`${app.name}-${index}`}>
                          <span className="cn-profile-app-initial" aria-hidden="true">
                            {appInitial(app.name)}
                          </span>
                          <span className="cn-profile-app-copy">
                            <strong>{app.name}</strong>
                            <span>{app.description}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                <div className="cn-sheet-actions">
                  <button className="cn-btn cn-btn-secondary" onClick={() => setProfile(null)}>Close</button>
                  {profile.host !== me?.host && (
                    <button
                      className="cn-btn cn-btn-primary"
                      onClick={() => { const p = profile; setProfile(null); onMessage(p.host, p.handle) }}
                    >
                      Message
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
