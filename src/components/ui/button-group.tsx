import * as React from 'react'
import { cn } from '@/lib/utils'

function ButtonGroup({ className, orientation = 'horizontal', ...props }: React.ComponentProps<'div'> & { orientation?: 'horizontal' | 'vertical' }) {
  return <div role="group" data-slot="button-group" data-orientation={orientation} className={cn('ui-button-group', className)} {...props} />
}

export { ButtonGroup }
