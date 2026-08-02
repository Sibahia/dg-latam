import * as path from "path";
import { patchSwf } from "../scripts/patch-dungeonblitz-gear-tooltip-stat-values";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SWF_PATH = path.join(ROOT, "src", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");

patchSwf(SWF_PATH, true, "original");

console.log("gear_tooltip_original_stat_values_regression passed");
