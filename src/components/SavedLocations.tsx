import { useId, useRef, useState } from 'react'
import {
  CaretDownIcon,
  CaretRightIcon,
  DotsSixVerticalIcon,
  FolderPlusIcon,
  PencilSimpleIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LocationSymbol } from '@/components/LocationSymbol'
import { formatCoordinates, locationKey, type LocationTarget } from '@/lib/locations'
import './SavedLocations.css'

type Groups = {
  groups: { id: string; name: string }[]
  membership: Record<string, string>
  collapsed: string[]
}
const GROUP_KEY = 'ethereal-location-groups-v1'
const LOCATION_DRAG_TYPE = 'application/x-ethereal-saved-location'
function loadGroups(): Groups {
  try {
    const value = JSON.parse(localStorage.getItem(GROUP_KEY) ?? '{}') as Partial<Groups>
    const groups = Array.isArray(value.groups)
      ? value.groups.filter(
          (g) =>
            g &&
            typeof g.id === 'string' &&
            typeof g.name === 'string' &&
            g.name.trim() &&
            g.name.length <= 80,
        )
      : []
    const membership = Object.fromEntries(
      Object.entries(value.membership ?? {}).filter(
        ([key, id]) => key.length < 100 && groups.some((g) => g.id === id),
      ),
    )
    const collapsed = Array.isArray(value.collapsed)
      ? [
          ...new Set(
            value.collapsed.filter(
              (id) => typeof id === 'string' && groups.some((g) => g.id === id),
            ),
          ),
        ]
      : []
    return { groups, membership, collapsed }
  } catch {
    return { groups: [], membership: {}, collapsed: [] }
  }
}

type SavedLocationsProps = {
  locations: LocationTarget[]
  onSelect: (location: LocationTarget) => void
  onRemove: (locations: LocationTarget[]) => void
  onEdit: (location: LocationTarget) => void
}

export function SavedLocations({ locations, onSelect, onRemove, onEdit }: SavedLocationsProps) {
  const [sectionOpen, setSectionOpen] = useState(true)
  const [collection, setCollection] = useState<Groups>(loadGroups)
  const [editingGroup, setEditingGroup] = useState<{ id: string; name: string } | null>(null)
  const [groupName, setGroupName] = useState('')
  const [notice, setNotice] = useState('')
  const [draggedKey, setDraggedKey] = useState<string | null>(null)
  const [dropGroup, setDropGroup] = useState<string | null>(null)
  const groupInput = useRef<HTMLInputElement>(null)
  const groupNameId = useId()
  const update = (next: Groups) => {
    setCollection(next)
    try {
      localStorage.setItem(GROUP_KEY, JSON.stringify(next))
      setNotice('')
    } catch {
      setNotice('Groups are available for this session. Browser storage is unavailable.')
    }
  }
  const editGroup = (group = { id: '', name: '' }) => {
    setGroupName(group.name)
    setEditingGroup(group)
  }
  const saveGroup = () => {
    const name = groupName.trim()
    if (!name || !editingGroup) return
    const group = { id: editingGroup.id || crypto.randomUUID(), name }
    update({
      ...collection,
      groups: editingGroup.id
        ? collection.groups.map((g) => (g.id === group.id ? group : g))
        : [...collection.groups, group],
    })
    setEditingGroup(null)
  }
  const deleteGroup = (id: string) => {
    onRemove(locations.filter((location) => collection.membership[locationKey(location)] === id))
    update({
      groups: collection.groups.filter((g) => g.id !== id),
      membership: Object.fromEntries(
        Object.entries(collection.membership).filter(([, group]) => group !== id),
      ),
      collapsed: collection.collapsed.filter((group) => group !== id),
    })
  }
  const setGroupOpen = (id: string, open: boolean) =>
    update({
      ...collection,
      collapsed: open
        ? collection.collapsed.filter((group) => group !== id)
        : [...collection.collapsed, id],
    })
  const dropLocation = (key: string, groupId: string) => {
    if (!locations.some((location) => locationKey(location) === key)) return
    update({
      ...collection,
      membership: { ...collection.membership, [key]: groupId },
      collapsed: collection.collapsed.filter((id) => id !== groupId),
    })
  }

  const rows = (items: LocationTarget[]) => (
    <ul className="saved-locations-list">
      {items.map((location) => (
        <li
          key={locationKey(location)}
          data-dragging={draggedKey === locationKey(location) || undefined}
        >
          <div className="saved-location-main">
            {collection.groups.length > 0 && (
              <span
                className="saved-location-drag"
                draggable
                title={`Drag ${location.name} to a group`}
                aria-hidden="true"
                onDragStart={(event) => {
                  const key = locationKey(location)
                  event.dataTransfer.setData(LOCATION_DRAG_TYPE, key)
                  event.dataTransfer.effectAllowed = 'move'
                  setDraggedKey(key)
                }}
                onDragEnd={() => {
                  setDraggedKey(null)
                  setDropGroup(null)
                }}
              >
                <DotsSixVerticalIcon size={16} />
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              className="saved-location-action saved-location-jump"
              onClick={() => onSelect(location)}
              aria-label={`Go to ${location.name}`}
            >
              <LocationSymbol icon={location.icon} color={location.color} size={18} />
              <span>
                <strong>{location.name}</strong>
                <span className="saved-location-coordinate-line">
                  <span>{formatCoordinates(location.coordinates)}</span>
                  {location.country && (
                    <span className="saved-location-country"> - {location.country}</span>
                  )}
                </span>
              </span>
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="saved-location-action saved-location-rename"
                  aria-label={`Edit ${location.name}`}
                  onClick={() => onEdit(location)}
                >
                  <PencilSimpleIcon size={16} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit location</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="saved-location-action saved-location-remove"
                  aria-label={`Remove ${location.name} from saved locations`}
                  onClick={() => onRemove([location])}
                >
                  <TrashIcon size={16} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Remove saved location</TooltipContent>
            </Tooltip>
          </div>
          {collection.groups.length > 0 && (
            <Select
              value={collection.membership[locationKey(location)] || 'ungrouped'}
              onValueChange={(value) =>
                update({
                  ...collection,
                  membership: { ...collection.membership, [locationKey(location)]: value },
                })
              }
            >
              <SelectTrigger
                className="saved-location-group-select"
                aria-label={`Group for ${location.name}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="ungrouped">Ungrouped</SelectItem>
                {collection.groups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </li>
      ))}
    </ul>
  )

  return (
    <Collapsible open={sectionOpen} onOpenChange={setSectionOpen} asChild>
      <section className="saved-locations" aria-label="Saved locations">
        <div className="saved-locations-heading">
          <h2>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="saved-locations-toggle"
                aria-label={`${sectionOpen ? 'Collapse' : 'Expand'} saved locations`}
              >
                {sectionOpen ? <CaretDownIcon size={16} /> : <CaretRightIcon size={16} />}
                Saved locations <span>({locations.length})</span>
              </Button>
            </CollapsibleTrigger>
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Create location group"
            onClick={() => editGroup()}
          >
            <FolderPlusIcon size={19} />
          </Button>
        </div>
        <CollapsibleContent>
          {!locations.length && (
            <p className="saved-locations-empty">
              Search for a place, then choose Save location below its pin.
            </p>
          )}
          {rows(
            locations.filter(
              (location) =>
                !collection.groups.some(
                  (g) => g.id === collection.membership[locationKey(location)],
                ),
            ),
          )}
          {collection.groups.map((group) => {
            const items = locations.filter(
              (location) => collection.membership[locationKey(location)] === group.id,
            )
            const open = !collection.collapsed.includes(group.id)
            return (
              <Collapsible
                key={group.id}
                open={open}
                onOpenChange={(next) => setGroupOpen(group.id, next)}
                asChild
              >
                <section
                  className="saved-location-group"
                  aria-label={group.name}
                  data-drop-target={dropGroup === group.id || undefined}
                  onDragOver={(event) => {
                    if (!draggedKey || !event.dataTransfer.types.includes(LOCATION_DRAG_TYPE))
                      return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    if (dropGroup !== group.id) setDropGroup(group.id)
                  }}
                  onDragLeave={(event) => {
                    if (
                      !(event.relatedTarget instanceof Node) ||
                      !event.currentTarget.contains(event.relatedTarget)
                    )
                      setDropGroup((current) => (current === group.id ? null : current))
                  }}
                  onDrop={(event) => {
                    if (!event.dataTransfer.types.includes(LOCATION_DRAG_TYPE)) return
                    event.preventDefault()
                    dropLocation(event.dataTransfer.getData(LOCATION_DRAG_TYPE), group.id)
                    setDraggedKey(null)
                    setDropGroup(null)
                  }}
                >
                  <div className="saved-group-heading">
                    <h3>
                      <CollapsibleTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          className="saved-group-toggle"
                          aria-label={`${open ? 'Collapse' : 'Expand'} ${group.name} group, ${items.length} locations`}
                        >
                          {open ? <CaretDownIcon size={14} /> : <CaretRightIcon size={14} />}
                          <span>{group.name}</span>
                          <span className="saved-group-count">{items.length}</span>
                        </Button>
                      </CollapsibleTrigger>
                    </h3>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Rename group ${group.name}`}
                      onClick={() => editGroup(group)}
                    >
                      <PencilSimpleIcon size={14} />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete group ${group.name} and its locations`}
                      title="Delete group and its locations"
                      onClick={() => deleteGroup(group.id)}
                    >
                      <TrashIcon size={14} />
                    </Button>
                  </div>
                  <CollapsibleContent>
                    {rows(items)}
                    {!items.length && (
                      <p className="saved-group-empty">
                        Drag a saved location here or use its group menu.
                      </p>
                    )}
                  </CollapsibleContent>
                </section>
              </Collapsible>
            )
          })}
          {notice && (
            <p role="status" className="saved-group-empty">
              {notice}
            </p>
          )}
        </CollapsibleContent>
        <Dialog
          open={editingGroup !== null}
          onOpenChange={(open) => {
            if (!open) setEditingGroup(null)
          }}
        >
          <DialogContent
            className="location-name-dialog"
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              groupInput.current?.focus()
              groupInput.current?.select()
            }}
          >
            <DialogHeader>
              <DialogTitle>{editingGroup?.id ? 'Rename group' : 'Create group'}</DialogTitle>
              <DialogDescription>Organize your saved locations.</DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                saveGroup()
              }}
            >
              <label htmlFor={groupNameId}>Group name</label>
              <Input
                ref={groupInput}
                id={groupNameId}
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                maxLength={80}
                required
                autoComplete="off"
              />
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline" type="button" size="sm">
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" size="sm" disabled={!groupName.trim()}>
                  Save
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </section>
    </Collapsible>
  )
}
