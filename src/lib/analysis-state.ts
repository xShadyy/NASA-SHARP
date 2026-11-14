import type { AnalysisArea } from '@/lib/analysis-area'

export type AnalysisState = {
  confirmed: AnalysisArea | null
  draft: AnalysisArea | null
  phase: 'idle' | 'drawing' | 'editing' | 'review'
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
  tool: null,
  error: null,
  vertices: 0,
  drawRequest: 0,
  fitRequest: 0,
}

export type AnalysisAction =
  | { type: 'preview'; area: AnalysisArea }
  | { type: 'draw'; tool: 'polygon' | 'rectangle' }
  | { type: 'drawing'; area: AnalysisArea | null; error: string | null; vertices: number }
  | { type: 'finish'; area: AnalysisArea; error: string | null }
  | { type: 'edit' }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'clear' }

export function analysisReducer(state: AnalysisState, action: AnalysisAction): AnalysisState {
  switch (action.type) {
    case 'preview':
      return {
        ...state,
        draft: action.area,
        phase: 'review',
        tool: null,
        error: null,
        fitRequest: state.fitRequest + 1,
      }
    case 'draw':
      return {
        ...state,
        draft: null,
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
        phase: area.type === 'country' ? 'review' : 'editing',
        tool: area.type === 'country' ? null : area.type,
        error: null,
        drawRequest: state.drawRequest + 1,
      }
    }
    case 'confirm':
      return state.draft && !state.error
        ? { ...state, confirmed: state.draft, draft: null, phase: 'idle', tool: null, vertices: 0 }
        : state
    case 'cancel':
      return {
        ...state,
        draft: null,
        phase: 'idle',
        tool: null,
        error: null,
        vertices: 0,
        fitRequest: state.fitRequest + (state.confirmed && state.phase !== 'idle' ? 1 : 0),
      }
    case 'clear':
      return {
        ...initialAnalysisState,
        drawRequest: state.drawRequest + 1,
        fitRequest: state.fitRequest,
      }
  }
}
