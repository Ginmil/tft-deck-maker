// 오프라인 테스트용 가상 세트 (실제 게임 데이터 아님). Community Dragon 원본과 같은 형식.
const traits = [
  ['TFT99_Duelist','결투가(샘플)',[2,4,6]], ['TFT99_Sniper','저격수(샘플)',[2,4]],
  ['TFT99_Bruiser','난동꾼(샘플)',[2,4,6]], ['TFT99_Sorc','마법사(샘플)',[2,4,6]],
  ['TFT99_Guard','수호자(샘플)',[2,4]], ['TFT99_Forest','숲(샘플)',[3,5,7]],
  ['TFT99_Fairy','요정(샘플)',[2,4,6]], ['TFT99_Beast','야수(샘플)',[2,3,4]],
  ['TFT99_Rogue','도적(샘플)',[2,4]], ['TFT99_King','숲의 왕(샘플)',[1]],
];
const N = Object.fromEntries(traits.map(([a,n])=>[a,n]));
const ch = (i,name,cost,ts,role)=>({apiName:`TFT99_Unit${i}`,name,cost,traits:ts.map(t=>N[t]),role,stats:{},squareIcon:null});
const champions = [
  ch(1,'참나무',1,['TFT99_Forest','TFT99_Guard'],'ADTank'),
  ch(2,'다람쥐',1,['TFT99_Beast','TFT99_Duelist'],'ADFighter'),
  ch(3,'반딧불',1,['TFT99_Fairy','TFT99_Sorc'],'APCaster'),
  ch(4,'여우',1,['TFT99_Beast','TFT99_Rogue'],'ADCarry'),
  ch(5,'이끼',1,['TFT99_Forest','TFT99_Bruiser'],'ADFighter'),
  ch(6,'솔방울',2,['TFT99_Forest','TFT99_Sniper'],'ADCarry'),
  ch(7,'곰',2,['TFT99_Beast','TFT99_Bruiser'],'ADTank'),
  ch(8,'꽃요정',2,['TFT99_Fairy','TFT99_Guard'],'APTank'),
  ch(9,'늑대',2,['TFT99_Beast','TFT99_Duelist'],'ADFighter'),
  ch(10,'버섯',2,['TFT99_Forest','TFT99_Sorc'],'APCaster'),
  ch(11,'올빼미',3,['TFT99_Sniper','TFT99_Fairy'],'ADCarry'),
  ch(12,'멧돼지',3,['TFT99_Bruiser','TFT99_Duelist'],'ADFighter'),
  ch(13,'버드나무',3,['TFT99_Forest','TFT99_Sorc'],'APCaster'),
  ch(14,'까마귀',3,['TFT99_Rogue','TFT99_Sniper'],'ADCarry'),
  ch(15,'사슴',3,['TFT99_Beast','TFT99_Guard'],'ADTank'),
  ch(16,'요정여왕',4,['TFT99_Fairy','TFT99_Sorc'],'APCarry'),
  ch(17,'검은표범',4,['TFT99_Beast','TFT99_Rogue','TFT99_Duelist'],'ADCarry'),
  ch(18,'고목',4,['TFT99_Forest','TFT99_Bruiser'],'ADTank'),
  ch(19,'매',4,['TFT99_Sniper','TFT99_Beast'],'ADCarry'),
  ch(20,'숲의왕',5,['TFT99_King','TFT99_Forest','TFT99_Duelist'],'ADCarry'),
  ch(21,'대마법요정',5,['TFT99_Fairy','TFT99_Sorc'],'APCarry'),
  ch(22,'거대곰',5,['TFT99_Bruiser','TFT99_Guard'],'ADTank'),
  {apiName:'TFT99_Summon',name:'소환된 묘목',cost:8,traits:[],role:''},
];
const setTraits = traits.map(([apiName,name,bps])=>({apiName,name,desc:`<b>${name}</b> 효과`,effects:bps.map(b=>({minUnits:b,maxUnits:25000}))}));
const item = (id,name,effects)=>({apiName:`TFT_Item_${id}`,name,composition:['A','B'],effects,associatedTraits:[],incompatibleTraits:[]});
const items = [
  item('IE','무한의 대검',{AD:0.35,CritChance:0.35}), item('LW','최후의 속삭임',{AD:0.15,AS:0.2,CritChance:0.2}),
  item('GS','거인 학살자',{AD:0.25,AP:20,AS:0.1}), item('JG','보석 건틀릿',{AP:35,CritChance:0.35}),
  item('Rab','라바돈의 죽음모자',{AP:50}), item('BG','푸른 파수꾼',{AP:20,Mana:10}),
  item('WM','워모그의 갑옷',{Health:600}), item('DC','용의 발톱',{MagicResist:65}),
  item('GA','가고일 돌갑옷',{Armor:25,MagicResist:25}), item('Bramble','가시 갑옷',{Armor:65}),
  {apiName:'TFT_Item_BFSword',name:'B.F. 대검',composition:[],effects:{AD:0.1}},
  {apiName:'TFT_Item_Artifact_Fishbones',name:'생선대가리(샘플 유물)',composition:[],effects:{}},
  {apiName:'TFT_Item_Artifact_Manazane',name:'마나자네(샘플 유물)',composition:[],effects:{}},
  {apiName:'TFT_Item_IERadiant',name:'찬란한 무한의 대검(샘플)',composition:[],effects:{}},
];
const emb = (t,name)=>({apiName:`TFT99_Item_${t}EmblemItem`,name,composition:['X','Y'],effects:{},associatedTraits:[`TFT99_${t}`],incompatibleTraits:[`TFT99_${t}`]});
items.push(emb('Duelist','결투가 상징'), emb('Sniper','저격수 상징'), emb('Fairy','요정 상징'), emb('Forest','숲 상징'), emb('Bruiser','난동꾼 상징'), emb('Sorc','마법사 상징'));
const raw = { items, setData:[{number:99,mutator:'TFTSet99',name:'샘플 세트(테스트용)',champions,traits:setTraits}] };
console.log(JSON.stringify(raw));
