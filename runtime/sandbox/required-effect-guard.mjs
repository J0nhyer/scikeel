import {runRequiredEffectGuard} from '../tools/native-tools.mjs';

if(process.argv.length!==3||process.argv[2]!=='--guard')process.exit(1);
await runRequiredEffectGuard();
