import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { streamURL } from './api';

/**
 * Subscribes to the API's Server-Sent Events and invalidates the matching
 * queries when ingest writes something, so lists and run pages update live.
 * On reconnect everything under the filter is refetched, which covers events
 * missed while the connection was down.
 */
export function useLive(filter: { project?: string; run?: string }, keys: unknown[][]): boolean {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const project = filter.project;
  const run = filter.run;
  const keysJSON = JSON.stringify(keys);

  useEffect(() => {
    if (typeof EventSource === 'undefined' || (!project && !run)) return;
    const params: Record<string, string> = {};
    if (project) params.project = project;
    if (run) params.run = run;
    const es = new EventSource(streamURL(params));
    const parsedKeys = JSON.parse(keysJSON) as unknown[][];
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Coalesce bursts: a busy run sends a batch every half second.
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        for (const k of parsedKeys) void qc.invalidateQueries({ queryKey: k });
      }, 300);
    };
    es.onopen = () => {
      setConnected(true);
      refresh();
    };
    es.onerror = () => setConnected(false);
    for (const t of ['run.started', 'run.batch', 'run.finished']) es.addEventListener(t, refresh);
    return () => {
      if (timer) clearTimeout(timer);
      es.close();
      setConnected(false);
    };
  }, [project, run, keysJSON, qc]);

  return connected;
}
