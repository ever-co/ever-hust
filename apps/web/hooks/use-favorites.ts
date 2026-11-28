"use client";

import { useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toggleSetMember } from "../lib/hook-utils";
import { responseErrorMessage } from "../lib/response-error";

const FAVORITE_FAILED = "Failed to update favorite";

/** A failed toggle whose message is meant for the user (the server's 409 reason or the generic text). */
class FavoriteToggleError extends Error {}

/**
 * Hook for managing the user's favorited jobs.
 *
 * - Loads favorites on mount from `/api/user/favorites`
 * - Provides an optimistic `toggleFavorite(jobId)` that persists via POST
 * - Exposes a `Set<number>` of favorited job IDs for O(1) lookup
 */
export function useFavorites() {
  const queryClient = useQueryClient();

  const { data: favoritedJobIds = new Set<number>(), isLoading } = useQuery({
    queryKey: ["favorites"],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/user/favorites", { signal });
      if (!res.ok) throw new Error("Failed to load favorites");
      const data = (await res.json()) as { favoriteJobIds: number[] };
      return new Set(data.favoriteJobIds);
    },
  });

  // Track in-flight toggles to prevent race conditions from rapid clicks
  const inFlightRef = useRef<Set<number>>(new Set());

  const { mutate: doToggle } = useMutation({
    mutationFn: async (jobId: number) => {
      const res = await fetch("/api/user/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      if (!res.ok) {
        // A 409 says why, e.g. the job is tracked as an application
        throw new FavoriteToggleError(
          res.status === 409
            ? await responseErrorMessage(res, FAVORITE_FAILED)
            : FAVORITE_FAILED,
        );
      }
      return (await res.json()) as { jobId: number; favorited: boolean };
    },
    onMutate: async (jobId: number) => {
      // Cancel any outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: ["favorites"] });
      const prev = queryClient.getQueryData<Set<number>>(["favorites"]);
      queryClient.setQueryData<Set<number>>(["favorites"], (old) =>
        old ? toggleSetMember(old, jobId) : old,
      );
      return { prev };
    },
    onError: (err, _jobId, context) => {
      // Rollback optimistic update
      if (context?.prev) {
        queryClient.setQueryData(["favorites"], context.prev);
      }
      // Only our own message: a network failure's TypeError ("Failed to fetch") is not for the user
      toast.error(
        err instanceof FavoriteToggleError ? err.message : FAVORITE_FAILED,
      );
    },
    onSuccess: (data) => {
      // Reconcile with server truth
      queryClient.setQueryData<Set<number>>(["favorites"], (old) => {
        if (!old) return old;
        const next = new Set(old);
        if (data.favorited) {
          next.add(data.jobId);
        } else {
          next.delete(data.jobId);
        }
        return next;
      });
      toast.success(
        data.favorited
          ? "Job added to favorites"
          : "Job removed from favorites",
      );
    },
    onSettled: (_data, _error, jobId) => {
      inFlightRef.current.delete(jobId);
    },
  });

  // Optimistic toggle with in-flight guard
  const toggleFavorite = useCallback(
    (jobId: number) => {
      if (inFlightRef.current.has(jobId)) return;
      inFlightRef.current.add(jobId);
      doToggle(jobId);
    },
    [doToggle],
  );

  const isFavorited = useCallback(
    (jobId: number) => favoritedJobIds.has(jobId),
    [favoritedJobIds],
  );

  const setFavoritedJobIds = useCallback(
    (updater: Set<number> | ((prev: Set<number>) => Set<number>)) => {
      queryClient.setQueryData<Set<number>>(["favorites"], (old) => {
        const current = old ?? new Set<number>();
        return typeof updater === "function" ? updater(current) : updater;
      });
    },
    [queryClient],
  );

  return {
    favoritedJobIds,
    isLoading,
    toggleFavorite,
    isFavorited,
    setFavoritedJobIds,
  };
}
