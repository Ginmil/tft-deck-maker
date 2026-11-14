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
// 재료 아이템 (실제 게임과 같은 apiName·조합식)
const C = { BF:'TFT_Item_BFSword', Bow:'TFT_Item_RecurveBow', Rod:'TFT_Item_NeedlesslyLargeRod', Tear:'TFT_Item_TearOfTheGoddess',
  Vest:'TFT_Item_ChainVest', Cloak:'TFT_Item_NegatronCloak', Belt:'TFT_Item_GiantsBelt', Glove:'TFT_Item_SparringGloves', Spat:'TFT_Item_Spatula' };
const comp = (key,name,effects)=>({apiName:C[key],name,composition:[],effects});
const item = (id,name,a,b,effects)=>({apiName:`TFT_Item_${id}`,name,composition:[C[a],C[b]],effects,associatedTraits:[],incompatibleTraits:[]});
const items = [
  comp('BF','B.F. 대검',{AD:0.1}), comp('Bow','곡궁',{AS:0.1}), comp('Rod','쓸데없이 큰 지팡이',{AP:10}),
  comp('Tear','여신의 눈물',{Mana:15}), comp('Vest','쇠사슬 조끼',{Armor:20}), comp('Cloak','음전자 망토',{MagicResist:20}),
  comp('Belt','거인의 허리띠',{Health:150}), comp('Glove','연습용 장갑',{CritChance:0.2}), comp('Spat','뒤집개',{}),
  item('IE','무한의 대검','BF','Glove',{AD:0.35,CritChance:0.35}), item('LW','최후의 속삭임','Bow','Glove',{AD:0.15,AS:0.2,CritChance:0.2}),
  item('GS','거인 학살자','BF','Bow',{AD:0.25,AP:20,AS:0.1}), item('Deathblade','죽음의 검','BF','BF',{AD:0.6}),
  item('RedBuff','붉은 덩굴정령','Bow','Bow',{AS:0.45}), item('Bloodthirster','피바라기','BF','Cloak',{AD:0.2,AP:20,MagicResist:20}),
  item('JG','보석 건틀릿','Rod','Glove',{AP:35,CritChance:0.35}), item('Rab','라바돈의 죽음모자','Rod','Rod',{AP:50}),
  item('BG','푸른 파수꾼','Tear','Tear',{AP:20,Mana:10}), item('Archangel','대천사의 지팡이','Rod','Tear',{AP:20,Mana:15}),
  item('Shojin','쇼진의 창','BF','Tear',{AD:0.15,AP:15,Mana:15}), item('Guinsoo','구인수의 격노검','Rod','Bow',{AP:10,AS:0.1}),
  item('WM','워모그의 갑옷','Belt','Belt',{Health:600}), item('DC','용의 발톱','Cloak','Cloak',{MagicResist:65}),
  item('GA','가고일 돌갑옷','Vest','Cloak',{Armor:25,MagicResist:25}), item('Bramble','가시 갑옷','Vest','Vest',{Armor:65}),
  item('Sunfire','태양불꽃 망토','Vest','Belt',{Armor:20,Health:250}), item('Titans','거인의 결의','Bow','Vest',{Armor:20,AS:0.1}),
  {apiName:'TFT_Item_Artifact_Fishbones',name:'생선대가리(샘플 유물)',composition:[],effects:{}},
  {apiName:'TFT_Item_Artifact_Manazane',name:'마나자네(샘플 유물)',composition:[],effects:{}},
  {apiName:'TFT_Item_IERadiant',name:'찬란한 무한의 대검(샘플)',composition:[],effects:{}},
];
const emb = (t,name,c)=>({apiName:`TFT99_Item_${t}EmblemItem`,name,composition:[C.Spat,C[c]],effects:{},associatedTraits:[`TFT99_${t}`],incompatibleTraits:[`TFT99_${t}`]});
items.push(emb('Duelist','결투가 상징','Bow'), emb('Sniper','저격수 상징','Glove'), emb('Fairy','요정 상징','Tear'), emb('Forest','숲 상징','Belt'), emb('Bruiser','난동꾼 상징','Vest'), emb('Sorc','마법사 상징','Rod'));
const raw = { items, setData:[{number:99,mutator:'TFTSet99',name:'샘플 세트(테스트용)',champions,traits:setTraits}] };
console.log(JSON.stringify(raw));
