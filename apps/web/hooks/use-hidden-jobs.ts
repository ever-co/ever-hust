"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { parseHiddenJobIds } from "../lib/hook-utils";
import { responseErrorMessage } from "../lib/response-error";

const HIDE_FAILED = "Failed to hide job";

/**
 * Hook to manage hidden jobs for the current user.
 * Fetches hidden job IDs from the server and provides toggle functionality.
 */
export function useHiddenJobs() {
  const [hiddenJobIds, setHiddenJobIds] = useState<Set<number>>(new Set());

  // Fetch hidden jobs on mount
  useEffect(() => {
    async function fetchHiddenJobs() {
      try {
        const res = await fetch("/api/user/hidden-jobs");
        if (res.ok) {
          const savedIds = parseHiddenJobIds(await res.json());
          if (savedIds.size > 0) {
            // Merge, so a job hidden while this request was in flight stays hidden
            setHiddenJobIds((prev) => new Set([...prev, ...savedIds]));
          }
        }
      } catch {
        // Silent fail — hidden jobs are a nice-to-have
      }
    }
    fetchHiddenJobs();
  }, []);

  const hideJob = useCallback(async (jobId: number) => {
    try {
      setHiddenJobIds((prev) => new Set([...prev, jobId]));

      const res = await fetch("/api/user/hidden-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });

      if (!res.ok) {
        // Revert optimistic update
        setHiddenJobIds((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
        // A 409 says why, e.g. the job is tracked as an application
        toast.error(
          res.status === 409
            ? await responseErrorMessage(res, HIDE_FAILED)
            : HIDE_FAILED,
        );
      } else {
        toast.success("Job hidden");
      }
    } catch {
      setHiddenJobIds((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
      toast.error(HIDE_FAILED);
    }
  }, []);

  const unhideJob = useCallback(async (jobId: number) => {
    try {
      setHiddenJobIds((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });

      const res = await fetch(`/api/user/hidden-jobs?jobId=${jobId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        setHiddenJobIds((prev) => new Set([...prev, jobId]));
        toast.error("Failed to unhide job");
      }
    } catch {
      setHiddenJobIds((prev) => new Set([...prev, jobId]));
      toast.error("Failed to unhide job");
    }
  }, []);

  const isHidden = useCallback(
    (jobId: number) => hiddenJobIds.has(jobId),
    [hiddenJobIds]
  );

  return { hiddenJobIds, hideJob, unhideJob, isHidden };
}
