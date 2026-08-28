// Syntax check for se-tracker.jsx. The app has no build step — the browser
// transforms the JSX at load time — so a typo surfaces as a blank page with a
// console error. This runs the same Babel transform up front instead.
//
//   npm run check
import { transformAsync } from '@babel/core';
import presetReact from '@babel/preset-react';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, '..', 'se-tracker.jsx');

try {
  await transformAsync(fs.readFileSync(file, 'utf-8'), {
    filename: file,
    presets: [presetReact],
    babelrc: false,
    configFile: false,
  });
  console.log('se-tracker.jsx: OK');
} catch (err) {
  console.error(`se-tracker.jsx: ${err.message}`);
  process.exit(1);
}
