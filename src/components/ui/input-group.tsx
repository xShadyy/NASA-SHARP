import * as React from 'react'
import { cn } from '@/lib/utils'

function InputGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="input-group" className={cn('ui-input-group', className)} {...props} />
}

function InputGroupAddon({
  className,
  align = 'inline-start',
  ...props
}: React.ComponentProps<'div'> & { align?: 'inline-start' | 'inline-end' }) {
  return (
    <div
      data-slot="input-group-addon"
      data-align={align}
      className={cn('ui-input-group-addon', className)}
      {...props}
    />
  )
}

function InputGroupInput({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      data-slot="input-group-control"
      className={cn('ui-input-group-control', className)}
      {...props}
    />
  )
}

export { InputGroup, InputGroupAddon, InputGroupInput }
