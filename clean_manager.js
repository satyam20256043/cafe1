const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'manager.html');
let content = fs.readFileSync(filePath, 'utf8');

const marker = '</style>\n</head>\n<body>';
const markerCRLF = '</style>\r\n</head>\r\n<body>';

let markerToUse = content.includes(markerCRLF) ? markerCRLF : marker;

const firstIdx = content.indexOf(markerToUse);
const secondIdx = content.indexOf(markerToUse, firstIdx + 1);

if (firstIdx !== -1 && secondIdx !== -1) {
  const before = content.substring(0, firstIdx + markerToUse.length);
  const after = content.substring(secondIdx + markerToUse.length);
  // Also clean up any extra newlines or spaces at the boundary
  const cleaned = before + '\n' + after.trimStart();
  fs.writeFileSync(filePath, cleaned, 'utf8');
  console.log('Successfully cleaned duplicate style block in public/manager.html!');
} else {
  console.error('Could not find both style blocks in public/manager.html. Indices:', firstIdx, secondIdx);
}
