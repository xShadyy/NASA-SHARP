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
import type { MeasurementTarget } from '@/map/measurement-controller'
import './LocationNameDialog.css'
import './MeasurementNameDialog.css'

type MeasurementNameDialogProps = {
  measurement: MeasurementTarget | null
  onSubmit: (name: string) => void
  onClose: () => void
  onCloseAutoFocus?: (event: Event) => void
}

function MeasurementNameForm({
  measurement,
  onSubmit,
  onClose,
  onCloseAutoFocus,
}: Omit<MeasurementNameDialogProps, 'measurement'> & { measurement: MeasurementTarget }) {
  const [name, setName] = useState(measurement.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="location-name-dialog measurement-name-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader className="location-name-header">
          <DialogTitle>Rename measurement</DialogTitle>
          <DialogDescription>
            {measurement.mode === 'area' ? 'Area' : 'Distance'} - {measurement.text}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit(name.trim())
          }}
        >
          <label htmlFor={id}>Measurement name</label>
          <Input
            ref={inputRef}
            id={id}
            name="measurement-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            autoComplete="off"
            placeholder={measurement.mode === 'area' ? 'Area' : 'Distance'}
            aria-describedby={hintId}
          />
          <p id={hintId} className="measurement-name-hint">
            Leave blank to remove the name.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}


export function MeasurementNameDialog(props: MeasurementNameDialogProps) {
  return props.measurement ? (
    <MeasurementNameForm
      key={`${props.measurement.id}:${props.measurement.name}`}
      {...props}
      measurement={props.measurement}
    />
  ) : null
}
