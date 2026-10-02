import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Cube} from '@phosphor-icons/react';
import {writeFile} from 'node:fs/promises';

// Reuse the existing Phosphor UI icon (MIT); no hand-drawn replacement asset.
const svg=renderToStaticMarkup(React.createElement(Cube,{size:1024,color:'#0865ed',weight:'regular'}));
await writeFile(new URL('../src-tauri/app-icon.svg',import.meta.url),svg);
