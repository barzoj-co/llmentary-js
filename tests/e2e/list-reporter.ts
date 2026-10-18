interface TaskLike {
  type?: string;
  name: string;
  mode?: string;
  result?: { state?: string };
  tasks?: TaskLike[];
}

interface ListedTest {
  fullName: string;
  mode: string;
  state: string;
}

function walk(tasks: TaskLike[] | undefined, ancestors: string[], out: ListedTest[]): void {
  for (const task of tasks ?? []) {
    const names = [...ancestors, task.name];
    if (task.type === "test" || (!task.tasks && task.type !== "suite")) {
      out.push({
        fullName: names.join(" > "),
        mode: task.mode ?? "run",
        state: task.result?.state ?? task.mode ?? "unknown",
      });
      continue;
    }
    walk(task.tasks, names, out);
  }
}

export default class E2eListReporter {
  onFinished(files: { tasks?: TaskLike[] }[] = []): void {
    const tests: ListedTest[] = [];
    for (const file of files) walk(file.tasks, [], tests);
    console.log("\nE2E tests that ran:");
    for (const test of tests) {
      console.log(`- [${test.state}] ${test.fullName}`);
    }
    const skipped = tests.filter(
      (test) => test.mode === "skip" || test.mode === "todo" || test.state === "skip" || test.state === "todo",
    );
    if (tests.length === 0) {
      throw new Error("E2E suite ran zero tests.");
    }
    if (skipped.length > 0) {
      const names = skipped.map((test) => test.fullName).join(", ");
      throw new Error(`E2E suite has ${skipped.length} skipped/todo test(s); none are allowed: ${names}`);
    }
  }
}
