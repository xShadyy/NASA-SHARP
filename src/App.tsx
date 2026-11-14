import { useEffect, useState } from 'react'
import { MantineProvider } from '@mantine/core'
import { CalendarDotsIcon, GlobeHemisphereWestIcon, InfoIcon, MoonIcon, SunIcon } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { TooltipProvider } from '@/components/ui/tooltip'

import './App.css'
import './components/sidebar.css'

type DatePeriod = '24 hours' | '7 days' | '30 days'
const mantineTheme = { fontFamily: '"Fira Sans", sans-serif', fontFamilyMonospace: '"Fira Sans", sans-serif' }


function ExplorerSidebar() {
  const { open, setOpen, isMobile, openMobile, setOpenMobile } = useSidebar()
  const expanded = isMobile ? openMobile : open
  function openGuide() {
    if (isMobile) setOpenMobile(true)
    else setOpen(true)
  }
  return <Sidebar id="explorer-sidebar" collapsible="icon" aria-label="Explorer navigation">
    <SidebarHeader><span className="sidebar-title">Ethereal</span><SidebarTrigger className="sidebar-collapse-trigger" /><Separator className="rail-separator" /></SidebarHeader>
    <SidebarContent>{expanded && <section className="sidebar-help" aria-label="Instructions" tabIndex={0}>
      <span className="sidebar-help-kicker">EXPLORER GUIDE</span><h2>Explore Earth</h2>
      <p>Choose a reference date and time range using the calendar. Today returns the reference date to the current day. Switch between light and dark themes using the top-right control.</p>
      
    </section>}</SidebarContent>
    <SidebarFooter><SidebarMenu><SidebarMenuItem><SidebarMenuButton className="rail-button" aria-label="Instructions" onClick={openGuide}><InfoIcon size={20} /><span className="sidebar-item-label">Instructions</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarFooter>
  </Sidebar>
}

function formatDate(value: Date | undefined) {
  return value ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(value) : 'Choose date'
}

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try { return localStorage.getItem('wildfire-theme') === 'dark' ? 'dark' : 'light' }
    catch { return 'light' }
  })
  const [date, setDate] = useState<Date | undefined>(() => new Date())
  const [calendarMonth, setCalendarMonth] = useState(() => new Date())
  const [period, setPeriod] = useState<DatePeriod>('24 hours')
  const themeAction = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'
  
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('wildfire-theme', theme) }
    catch { /* The selected theme still works without browser storage. */ }
  }, [theme])
  

  return <MantineProvider theme={mantineTheme} forceColorScheme={theme}><TooltipProvider>
    <div className="app-shell">
      <header className="app-header">
        <div className="header-brand" aria-label="Ethereal wildfire explorer"><span className="brand-symbol"><GlobeHemisphereWestIcon size={19} /></span><span>ETHEREAL <span className="brand-suffix">/ OUR TOOL NAME</span></span></div>
        <div className="header-actions">
          <Popover>
            <PopoverTrigger asChild><Button type="button" variant="outline" className="date-control" aria-label="Choose reference date and time range"><CalendarDotsIcon size={16} /><span className="date-label">{formatDate(date)}</span><span className="date-divider">·</span><span className="period-label">{period}</span></Button></PopoverTrigger>
            <PopoverContent align="center" side="bottom" collisionPadding={8} className="date-popover">
              <Calendar mode="single" fixedWeeks selected={date} month={calendarMonth} onMonthChange={setCalendarMonth} onSelect={(selected) => { setDate(selected); if (selected) setCalendarMonth(selected) }} timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone} className="calendar-picker" />
              <Separator className="date-range-divider" />
              <div className="date-range-actions">
                <ToggleGroup type="single" className="date-range-options" value={period} onValueChange={(value) => { if (value === '24 hours' || value === '7 days' || value === '30 days') setPeriod(value) }} aria-label="Time range">
                  {[['24 hours', '24h'], ['7 days', '7d'], ['30 days', '30d']].map(([value, label]) => <ToggleGroupItem key={value} value={value} aria-label={value}>{label}</ToggleGroupItem>)}
                </ToggleGroup>
                <Button type="button" variant="ghost" size="sm" className="date-reset" onClick={() => { const today = new Date(); setDate(today); setCalendarMonth(today) }}>Today</Button>
              </div>
            </PopoverContent>
          </Popover>
          <Button type="button" variant="outline" size="icon" className="theme-toggle" aria-label={themeAction} onClick={() => setTheme((current) => current === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <MoonIcon size={18} /> : <SunIcon size={18} />}</Button>
        </div>
      </header>
      <SidebarProvider defaultOpen={false} className="app-body"><ExplorerSidebar />
        <main className="explorer-stage" aria-label="Global Earth explorer">
          <section className="workspace-empty" aria-label="Explorer workspace"><output>{formatDate(date)} · {period}</output></section>
          
        </main>
      </SidebarProvider>
    </div>
  </TooltipProvider></MantineProvider>
}

export default App
