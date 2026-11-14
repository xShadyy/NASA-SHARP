import type { ComponentProps } from 'react'
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import { CaretRightIcon, CheckIcon } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'

function ContextMenu(props: ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger(props: ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
}

function ContextMenuContent({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return <ContextMenuPrimitive.Portal><ContextMenuPrimitive.Content data-slot="context-menu-content" collisionPadding={8} className={cn('ui-context-menu', className)} {...props} /></ContextMenuPrimitive.Portal>
}

function ContextMenuItem({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.Item>) {
  return <ContextMenuPrimitive.Item data-slot="context-menu-item" className={cn('ui-context-menu-item', className)} {...props} />
}

function ContextMenuLabel({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.Label>) {
  return <ContextMenuPrimitive.Label data-slot="context-menu-label" className={cn('ui-context-menu-label', className)} {...props} />
}

function ContextMenuSeparator({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator data-slot="context-menu-separator" className={cn('ui-context-menu-separator', className)} {...props} />
}

function ContextMenuSub(props: ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />
}

function ContextMenuSubTrigger({ className, children, ...props }: ComponentProps<typeof ContextMenuPrimitive.SubTrigger>) {
  return <ContextMenuPrimitive.SubTrigger data-slot="context-menu-sub-trigger" className={cn('ui-context-menu-item ui-context-menu-sub-trigger', className)} {...props}>
    {children}<CaretRightIcon className="ui-context-menu-sub-arrow" size={14} aria-hidden="true" />
  </ContextMenuPrimitive.SubTrigger>
}

function ContextMenuSubContent({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return <ContextMenuPrimitive.Portal><ContextMenuPrimitive.SubContent data-slot="context-menu-sub-content" collisionPadding={8} className={cn('ui-context-menu ui-context-menu-sub-content', className)} {...props} /></ContextMenuPrimitive.Portal>
}

function ContextMenuRadioGroup(props: ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />
}

function ContextMenuRadioItem({ className, children, ...props }: ComponentProps<typeof ContextMenuPrimitive.RadioItem>) {
  return <ContextMenuPrimitive.RadioItem data-slot="context-menu-radio-item" className={cn('ui-context-menu-item ui-context-menu-radio-item', className)} {...props}>
    <span className="ui-context-menu-radio-indicator" aria-hidden="true"><ContextMenuPrimitive.ItemIndicator><CheckIcon size={15} /></ContextMenuPrimitive.ItemIndicator></span>
    {children}
  </ContextMenuPrimitive.RadioItem>
}

export { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent, ContextMenuRadioGroup, ContextMenuRadioItem }
