const BASE = 'assets/sprites/';

const DEFS = [
  ['boat',     'boat.png'    ],
  ['wall',     'wall.png'    ],
  ['sticky',   'sticky.png'  ],
  ['crumble',  'crumble.png' ],
  ['onewayL',  'oneway-l.png'],
  ['onewayR',  'oneway-r.png'],
  ['onewayU',  'oneway-u.png'],
  ['onewayD',  'oneway-d.png'],
  ['teleport', 'teleport.png'],
  ['player',   'player.png'  ],
  ['goal',     'goal.png'    ],
];

export async function loadSprites() {
  const sprites = {};
  await Promise.allSettled(DEFS.map(([key, file]) =>
    new Promise((res, rej) => {
      const img = new Image();
      img.onload  = () => { sprites[key] = img; res(); };
      img.onerror = rej;
      img.src = BASE + file;
    })
  ));
  return sprites;
}
