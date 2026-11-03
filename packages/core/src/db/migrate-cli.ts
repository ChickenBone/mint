import { closeDb } from "./index";
import { runMigrations } from "./migrate";

runMigrations()
  .then(() => console.log("[db] migrations applied"))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closeDb);
