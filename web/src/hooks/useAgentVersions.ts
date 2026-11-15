import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { AgentVersions } from '@/lib/agentUpdate'

/** Agent version the console hands out per platform (drives the "Update available" badges). */
export function useAgentVersions() {
  return useQuery({
    queryKey: ['agent-versions'],
    queryFn: () => api.get<AgentVersions>('/api/agent/versions'),
    staleTime: 5 * 60_000,
    retry: false,
  })
}
