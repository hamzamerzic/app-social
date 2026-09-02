import { useEffect, useState } from 'react'
import { Mail, Plus } from '@openai/apps-sdk-ui/components/Icon'
import { timeAgo, initials, createGroup, searchPeople } from '../api.js'
import { Avatar } from './Board.jsx'

function GroupAvatar({ name }) {
  return (
    <span className="cn-avatar is-group" aria-hidden="true">
      {initials(name, name)}
    </span>
  )
}

export { GroupAvatar }

function lastMessagePreview(item) {
  const text = String(item.last_text || '').trim()
  if (text) return text
  if (item.last_attachment || item.last_message?.attachment || item.attachment) return '📷 Photo'
  return ''
}

export default function Messages({
  me, conversations, groups, onOpenThread, onOpenGroup, onFindPeople,
  onGroupsChanged, showToast, creating, setCreating,
}) {

  const merged = [
    ...conversations.map((c) => ({ kind: 'dm', key: c.peer, at: c.last_at || 0, item: c })),
    ...groups.map((g) => ({ kind: 'group', key: g.gid, at: g.last_at || 0, item: g })),
  ].sort((a, b) => b.at - a.at)

  return (
    <div className="cn-content cn-screen">
      {merged.length === 0 ? (
        <div className="cn-empty">
          <div className="cn-empty-mark" aria-hidden="true"><Mail /></div>
          <div className="cn-empty-title">No conversations yet</div>
          <p className="cn-empty-text">
            Find someone in People and say hello — your message goes straight to their server.
          </p>
          <button className="cn-btn cn-btn-primary" onClick={onFindPeople}>Find people</button>
        </div>
      ) : (
        <div>
          {merged.map(({ kind, key, item }) => (
            kind === 'dm' ? (
              <button className="cn-row" key={`dm-${key}`} onClick={() => onOpenThread(item.peer)}>
                <Avatar name={item.peer_handle} host={item.peer} />
                <span className="cn-row-copy">
                  <span className="cn-row-top">
                    <strong>{item.peer_handle ? `@${item.peer_handle}` : 'Direct message'}</strong>
                    <span className="cn-time">{timeAgo(item.last_at)}</span>
                  </span>
                  <span className="cn-preview">
                    {item.last_dir === 'out' ? 'You: ' : ''}{lastMessagePreview(item)}
                  </span>
                </span>
                {item.unread > 0 && <span className="cn-unread-dot" aria-label="Unread" />}
              </button>
            ) : (
              <button className="cn-row" key={`g-${key}`} onClick={() => onOpenGroup(item)}>
                <GroupAvatar name={item.name} />
                <span className="cn-row-copy">
                  <span className="cn-row-top">
                    <strong>{item.name}</strong>
                    <span className="cn-time">{timeAgo(item.last_at)}</span>
                  </span>
                  <span className="cn-preview">
                    {lastMessagePreview(item)
                      ? `${item.last_dir === 'out'
                        ? 'You'
                        : item.last_from_handle ? `@${item.last_from_handle}` : 'Someone'}: ${lastMessagePreview(item)}`
                      : `${(item.members || []).length} people`}
                  </span>
                </span>
                {item.unread > 0 && <span className="cn-unread-dot" aria-label="Unread" />}
              </button>
            )
          ))}
        </div>
      )}

      {creating && (
        <NewGroupSheet
          me={me}
          onClose={() => setCreating(false)}
          onCreated={(gid) => { setCreating(false); onGroupsChanged(gid) }}
          showToast={showToast}
        />
      )}
    </div>
  )
}

function NewGroupSheet({ me, onClose, onCreated, showToast }) {
  const [name, setName] = useState('')
  const [people, setPeople] = useState(null)
  const [selected, setSelected] = useState({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    searchPeople('')
      .then((found) => setPeople(found.users.filter((u) => u.host !== me?.host)))
      .catch(() => setPeople([]))
  }, [])

  async function create() {
    const groupName = name.trim()
    if (!groupName) return
    setBusy(true)
    try {
      const result = await createGroup(groupName, Object.keys(selected).filter((h) => selected[h]))
      window.mobius?.signal?.('item_created', { type: 'group' })
      const unreachable = Object.entries(result.invited || {})
        .filter(([, ok]) => !ok).map(([h]) => h)
      if (unreachable.length) {
        const count = unreachable.length
        showToast(`Created — ${count} ${count === 1 ? 'person' : 'people'} couldn’t be reached yet.`, 'error')
      } else {
        showToast('Group created', 'success')
      }
      onCreated(result.gid)
    } catch (error) {
      window.mobius?.signal?.('error', { message: error.message, source: 'create_group' })
      showToast(error.message, 'error')
      setBusy(false)
    }
  }

  return (
    <div className="cn-scrim" role="dialog" aria-modal="true" aria-label="New group"
         onClick={busy ? null : onClose}>
      <div className="cn-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="cn-grabber" aria-hidden="true" />
        <h3 className="cn-sheet-title">New group</h3>
        <p className="cn-sheet-body">
          The group lives on your server; members’ servers each keep their own copy.
        </p>
        <input className="cn-input" value={name} onChange={(e) => setName(e.target.value)}
               placeholder="Group name" autoFocus />
        <div style={{ marginTop: 14 }}>
          {people === null && <div className="cn-center"><div className="cn-spinner" /></div>}
          {people !== null && people.length === 0 && (
            <p className="cn-sheet-body">
              No one else is in your directory yet — you can still create the
              group and add people later.
            </p>
          )}
          {(people || []).map((user) => (
            <label className="cn-member-row" key={user.host}>
              <input
                type="checkbox"
                checked={!!selected[user.host]}
                onChange={(e) => setSelected({ ...selected, [user.host]: e.target.checked })}
              />
              <Avatar name={user.handle} host={user.host} size="small" />
              <span className="cn-row-copy">
                <strong style={{ fontSize: 14 }}>{user.handle ? `@${user.handle}` : 'Social member'}</strong>
              </span>
            </label>
          ))}
        </div>
        <div className="cn-sheet-actions">
          <button className="cn-btn cn-btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="cn-btn cn-btn-primary" onClick={create} disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create group'}
          </button>
        </div>
      </div>
    </div>
  )
}
