import { useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
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
import { formatCoordinates, locationKey, type LocationTarget } from '@/lib/locations'
import './LocationNameDialog.css'

type LocationNameDialogProps = {
  location: LocationTarget | null
  title: string
  onSubmit: (name: string) => void
  onClose: () => void
}

function LocationNameForm({
  location,
  title,
  onSubmit,
  onClose,
}: Omit<LocationNameDialogProps, 'location'> & { location: LocationTarget }) {
  const [name, setName] = useState(location.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="location-name-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
        }}
      >
        <DialogHeader className="location-name-header">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {formatCoordinates(location.coordinates)}
            {location.country ? ` · ${location.country}` : ''}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim()) onSubmit(name.trim())
          }}
        >
          <label htmlFor={id}>Location name</label>
          <Input
            ref={inputRef}
            id={id}
            name="location-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            autoComplete="off"
            required
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={!name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function LocationNameDialog(props: LocationNameDialogProps) {
  return props.location ? (
    <LocationNameForm
      key={`${locationKey(props.location)}:${props.location.name}`}
      {...props}
      location={props.location}
    />
  ) : null
}
