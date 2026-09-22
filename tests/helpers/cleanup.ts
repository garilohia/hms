export type CleanupTask = {
  label: string;
  run: () => unknown | Promise<unknown>;
};

function labelledFailure(label: string, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${label}: ${detail}`, { cause });
}

export async function runCleanup(tasks: CleanupTask[], message = "Synthetic fixture cleanup failed.") {
  const failures: Error[] = [];
  for (const task of tasks) {
    try {
      await task.run();
    } catch (error) {
      failures.push(labelledFailure(task.label, error));
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}
