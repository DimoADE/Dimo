import { create } from 'zustand';

interface AgentCommandOutputState {
  outputByTool: Record<string, string>;
  setOutput: (toolUseId: string, output: string) => void;
  clear: (toolUseId: string) => void;
}

const MAX_TRACKED_COMMAND_TOOLS = 64;
const MAX_COMMAND_OUTPUT_CHARS = 256 * 1024;

function trimOutputTail(output: string): string {
  if (output.length <= MAX_COMMAND_OUTPUT_CHARS) {
    return output;
  }
  return output.slice(output.length - MAX_COMMAND_OUTPUT_CHARS);
}

export const useAgentCommandOutputStore = create<AgentCommandOutputState>(
  (set) => ({
    outputByTool: {},
    setOutput: (toolUseId, output) =>
      set((state) => {
        const bounded = trimOutputTail(output);
        if (state.outputByTool[toolUseId] === bounded) {
          return state;
        }
        const next: Record<string, string> = {};
        for (const key of Object.keys(state.outputByTool)) {
          if (key !== toolUseId) {
            next[key] = state.outputByTool[key];
          }
        }
        next[toolUseId] = bounded;
        const keys = Object.keys(next);
        if (keys.length > MAX_TRACKED_COMMAND_TOOLS) {
          const overflow = keys.length - MAX_TRACKED_COMMAND_TOOLS;
          for (let i = 0; i < overflow; i += 1) {
            delete next[keys[i]];
          }
        }
        return { outputByTool: next };
      }),
    clear: (toolUseId) =>
      set((state) => {
        if (!(toolUseId in state.outputByTool)) {
          return state;
        }
        const outputByTool = { ...state.outputByTool };
        delete outputByTool[toolUseId];
        return { outputByTool };
      }),
  })
);
