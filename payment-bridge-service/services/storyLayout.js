// Coordinates refer to the owner's original 900x1600 artwork. Keep both copies identical.
export const storyLayouts = {
 solo:{name:[450,660,410,36],score:[404,989,140,58],win:[500,1220,355,28]},
 friends:{name:[484,606,315,30],partner:[484,657,315,30],score:[309,945,70,40],partnerScore:[543,945,70,40],win:[465,1142,465,25],goal:[465,1283,425,26]},
 couple:{name:[294,621,205,30],partner:[607,621,205,30],score:[271,939,75,40],partnerScore:[558,939,75,40],win:[477,1132,385,24],goal:[477,1272,385,25]}
};
export function storyFields(card,summary) {
 const score=typeof summary?.score==='number'&&Number.isFinite(summary.score)&&summary.score>=0&&summary.score<=100?String(Math.round(summary.score)):'—';
 const win=typeof summary?.win==='string'&&summary.win.trim()?summary.win:'Completed my check-in';
 const solo=card.relationship==='solo';
 return {name:card.alias||'Your name',partner:card.partner||'Their name',score,partnerScore:'—',win:solo?win:`${card.alias||'Me'}: ${win}`,winNote:solo?'': 'Second scan not linked',goal:'Make time for our next check'};
}
