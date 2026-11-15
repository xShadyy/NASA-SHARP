import type { AnalysisArea } from '@/lib/analysis-area'

export type AnalysisState = {
  confirmed: AnalysisArea | null
  draft: AnalysisArea | null
  phase: 'idle' | 'loading' | 'drawing' | 'editing' | 'review'
  pendingCountry: { id: string; name: string } | null
  tool: 'polygon' | 'rectangle' | null
  error: string | null
  vertices: number
  drawRequest: number
  fitRequest: number
}

export const initialAnalysisState: AnalysisState = {
  confirmed: null,
  draft: null,
  phase: 'idle',
  pendingCountry: null,
  tool: null,
  error: null,
  vertices: 0,
  drawRequest: 0,
  fitRequest: 0,
}

export type AnalysisAction =
  | { type: 'country-loading'; country: { id: string; name: string } }
  | { type: 'country-failure'; error: string }
  | { type: 'preview'; area: AnalysisArea }
  | { type: 'draw'; tool: 'polygon' | 'rectangle' }
  | { type: 'drawing'; area: AnalysisArea | null; error: string | null; vertices: number }
  | { type: 'finish'; area: AnalysisArea; error: string | null }
  | { type: 'edit' }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'clear' }
  | { type: 'fit' }
  | { type: 'apply-investigation'; area: AnalysisArea | null }

export function analysisReducer(state: AnalysisState, action: AnalysisAction): AnalysisState {
  switch (action.type) {
    case 'apply-investigation':
      
      return { ...state, confirmed: action.area }
    case 'country-loading':
      return {
        ...state,
        draft: null,
        pendingCountry: action.country,
        phase: 'loading',
        tool: null,
        error: null,
        vertices: 0,
      }
    case 'country-failure':
      return {
        ...state,
        draft: null,
        pendingCountry: null,
        phase: 'idle',
        tool: null,
        error: action.error,
      }
    case 'preview':
      return {
        ...state,
        draft: action.area,
        pendingCountry: null,
        phase: 'review',
        tool: null,
        error: null,
        fitRequest: state.fitRequest + (action.area.type === 'country' ? 1 : 0),
      }
    case 'draw':
      return {
        ...state,
        draft: null,
        pendingCountry: null,
        phase: 'drawing',
        tool: action.tool,
        error: null,
        vertices: 0,
        drawRequest: state.drawRequest + 1,
      }
    case 'drawing':
      return { ...state, draft: action.area, error: action.error, vertices: action.vertices }
    case 'finish':
      return {
        ...state,
        draft: action.area,
        error: action.error,
        phase: action.error ? 'editing' : 'review',
        fitRequest: state.fitRequest + (action.error ? 0 : 1),
      }
    case 'edit': {
      const area = state.draft ?? state.confirmed
      if (!area) return state
      return {
        ...state,
        draft: structuredClone(area),
        pendingCountry: null,
        phase: area.type === 'country' ? 'review' : 'editing',
        tool: area.type === 'country' ? null : area.type,
        error: null,
        drawRequest: state.drawRequest + 1,
      }
    }
    case 'confirm': {
      const ready =
        state.draft?.type !== 'country' ||
        Boolean(
          state.draft.sourceGeometry &&
          state.draft.displayGeometry &&
          state.draft.displayBoundary &&
          state.draft.boundaryRef,
        )
      return state.draft && !state.error && state.phase !== 'loading' && ready
        ? {
            ...state,
            confirmed: state.draft,
            draft: null,
            pendingCountry: null,
            phase: 'idle',
            tool: null,
            vertices: 0,
            fitRequest: state.fitRequest + (state.draft.type === 'country' ? 0 : 1),
          }
        : state
    }
    case 'cancel':
      return {
        ...state,
        draft: null,
        pendingCountry: null,
        phase: 'idle',
        tool: null,
        error: null,
        vertices: 0,
      }
    case 'clear':
      return {
        ...initialAnalysisState,
        drawRequest: state.drawRequest + 1,
        fitRequest: state.fitRequest,
      }
    case 'fit':
      return state.draft || state.confirmed ? { ...state, fitRequest: state.fitRequest + 1 } : state
  }
}
