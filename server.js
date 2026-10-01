const express=require("express"), http=require("http"), QRCode=require("qrcode"), multer=require("multer"), pdfParse=require("pdf-parse"), crypto=require("crypto");
const {Server}=require("socket.io"), {Pool}=require("pg");
const app=express(), srv=http.createServer(app), io=new Server(srv);
const up=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024}});
app.use(express.static("public")); app.use(express.json({limit:"20mb"}));
const AI_READY=!!process.env.OPENAI_API_KEY, DB_READY=!!process.env.DATABASE_URL;
const MODEL=process.env.OPENAI_MODEL||"gpt-5.6-luna";
let pool=null;if(DB_READY)pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const mem={history:[],vocabAttempts:[]};
async function initDB(){if(!pool)return;await pool.query(`create table if not exists exam_history(id bigserial primary key, school text, grade text, mode text, source_hash text, qtype text, question jsonb, created_at timestamptz default now())`);await pool.query(`create table if not exists vocab_attempts(id bigserial primary key, student text, class_name text, set_name text, total int, correct int, wrong_words jsonb, created_at timestamptz default now())`)}initDB().catch(console.error);
const grammarGroups={
"기초 문장": ["BE동사 현재형(am/is/are)","BE동사 과거형(was/were)","일반동사 현재형","일반동사 과거형","의문문·부정문","명령문","There is/are","감탄문","1형식","2형식","3형식","4형식","5형식"],
"명사·대명사·관사": ["명사의 단수·복수","셀 수 있는/없는 명사","관사(a/an/the)","인칭대명사","소유격·소유대명사","재귀대명사","부정대명사","지시대명사","one/ones","it 용법","가주어 it","비인칭주어 it"],
"시제·태": ["현재시제","과거시제","미래시제","현재진행","과거진행","미래진행","현재완료","과거완료","미래완료","현재완료진행","과거완료진행","수동태 기본","4형식 수동태","5형식 수동태","조동사 수동태","완료 수동태"],
"조동사": ["can/could","may/might","must/have to","should/ought to","will/would","had better","used to","would like to","조동사+have p.p.","추측의 조동사"],
"준동사": ["to부정사 명사적 용법","to부정사 형용사적 용법","to부정사 부사적 용법","의문사+to부정사","too...to","enough to","동명사","동명사 vs to부정사","분사(현재분사/과거분사)","분사구문","완료 분사구문","독립 분사구문","with+O+분사"],
"관계사·접속사": ["관계대명사 who","관계대명사 which","관계대명사 that","관계대명사 what","관계대명사 whose","관계대명사 목적격 생략","관계대명사 계속적 용법","전치사+관계대명사","관계부사 when","관계부사 where","관계부사 why","관계부사 how","복합관계대명사","복합관계부사","명사절 접속사 that","whether/if 명사절","간접의문문","부사절 접속사","상관접속사"],
"형용사·부사·비교": ["형용사/부사 구별","빈도부사","enough 위치","원급 비교","비교급","최상급","비교급 강조","the 비교급, the 비교급","배수 표현","비교급 관용표현"],
"일치·특수구문": ["주어·동사 수일치","시제 일치","대명사 일치","가정법 과거","가정법 과거완료","혼합가정법","I wish 가정법","as if 가정법","도치","부정어 도치","Only 도치","강조구문 It is...that","생략","대용","동격 that","병렬구조","부정사 의미상 주어","동명사 의미상 주어"],
"동사 핵심": ["지각동사","사역동사","준사역동사 help","5형식 목적격보어","수여동사","자동사/타동사","동사+전치사","동사+동명사","동사+to부정사","목적어로 that절","목적보어 형용사"],
"전치사·기타": ["시간 전치사","장소 전치사","전치사+동명사","접속사 vs 전치사","수량형용사 many/much/few/little","each/every/all/both","부분부정","전체부정","부정어","화법 전환","특수 의문문","부가의문문"]};
const mockTypes=["목적","심경/분위기","주장","밑줄 의미/함의","요지","주제","제목","내용 일치","내용 불일치","어법","문맥상 어휘","빈칸 추론","무관한 문장","글의 순서","문장 삽입","요약문 완성","지칭 추론","장문 제목","장문 어휘","장문 순서","장문 내용 일치/불일치"];
const simulGroups={"독해 전 유형":mockTypes,"학교 내신형":["본문 빈칸","본문 어휘 변형","본문 어법 변형","문장 배열","영영풀이","어휘 관계","문장 전환","조건 영작","서술형 영작","내용 요약 서술형","문법 오류 고쳐쓰기","우리말에 맞게 영작","주어진 단어 배열","대화문 완성","교과서 핵심문장"],"문법 개별 출제":["문법 종합","관계사","시제","수동태","준동사","가정법","비교","접속사","수일치","5형식"]};
app.get("/api/status",(q,s)=>s.json({ai:AI_READY,db:DB_READY,version:"2.4-teacher-logic-new-item"}));
app.get("/api/config",(q,s)=>s.json({grammarGroups,grammarFormats:["5지선다","괄호 양자택일","어법 오류 찾기","고쳐쓰기","영작","문장 배열","문장 형식 판단","빈칸 완성"],mockTypes,simulGroups}));
app.post("/api/extract/pdf",up.single("file"),async(req,res)=>{try{if(!req.file)return res.status(400).json({error:"PDF 파일이 없습니다."});const d=await pdfParse(req.file.buffer);res.json({text:d.text||""})}catch(e){res.status(500).json({error:"PDF 텍스트 추출에 실패했습니다: "+e.message})}});
async function aiText(instructions,input){if(!AI_READY)throw Error("OPENAI_API_KEY가 연결되지 않았습니다. Render 환경변수에 키를 추가해주세요.");const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"Authorization":"Bearer "+process.env.OPENAI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({model:MODEL,instructions,input,reasoning:{effort:"medium"}})});const j=await r.json();if(!r.ok)throw Error(j.error?.message||"OpenAI API 오류");return j.output_text||j.output?.flatMap(x=>x.content||[]).map(x=>x.text||"").join("")||""}
function cleanJson(t){const a=t.indexOf("{");const b=t.lastIndexOf("}");if(a<0||b<a)throw Error("AI 결과를 JSON으로 읽지 못했습니다.");return JSON.parse(t.slice(a,b+1))}
function hash(t){return crypto.createHash("sha256").update(String(t||"")).digest("hex").slice(0,24)}
async function recentHistory(school,mode){if(pool){const r=await pool.query("select question,qtype from exam_history where mode=$1 and ($2='' or school=$2) order by created_at desc limit 80",[mode,school||""]);return r.rows}return mem.history.filter(x=>x.mode===mode&&(!school||x.school===school)).slice(0,80)}
async function saveHistory(meta,questions){for(const q of questions){if(pool)await pool.query("insert into exam_history(school,grade,mode,source_hash,qtype,question) values($1,$2,$3,$4,$5,$6)",[meta.school||"",meta.grade||"",meta.mode,meta.sourceHash,q.type||"",JSON.stringify(q)]);else mem.history.unshift({...meta,qtype:q.type||"",question:q,created_at:new Date().toISOString()})}}
app.post("/api/analyze-school",async(req,res)=>{try{const b=req.body||{};const out=await aiText("너는 한국 중고등학교 영어 내신 시험지 분석가다. 평가나 추측보다 실제 입력 시험지에서 확인되는 형식만 분석한다.",`학교: ${b.school||"미입력"}\n학년: ${b.grade||""}\n다음 기출 시험지를 분석해서 한국어로 간결하게 정리하라. 반드시 ① 객관식/서술형 구성 ② 반복되는 발문/문항 유형 ③ 선택지 특징 ④ 본문 변형 방식 ⑤ 문법/어휘 출제 방식 ⑥ 새 시험을 만들 때 따라야 할 형식 규칙 순서로 작성하라.\n\n${String(b.text||"").slice(0,50000)}`);res.json({analysis:out})}catch(e){res.status(500).json({error:e.message})}});
app.post("/api/generate",async(req,res)=>{try{const b=req.body||{},mode=b.mode;if(!["weekly","simul"].includes(mode))return res.status(400).json({error:"잘못된 모드입니다."});const school=mode==='simul'?(b.school||""):"";const hist=await recentHistory(school,mode);const old=hist.map((x,i)=>`${i+1}. [${x.qtype||""}] ${x.question?.prompt||""} / 정답근거:${x.question?.evidence||""}`).join("\n").slice(0,18000);
const base=`너는 JONG-RO M ENGLISH 시험 출제 엔진이다. 한국 중고등학교 영어시험을 만든다. 반드시 유효한 JSON 객체만 출력한다. 스키마: {"title":"...","questions":[{"type":"유형","prompt":"발문","passage":"필요할 때만 원문/문장","options":["선택지1","선택지2","선택지3","선택지4","선택지5"],"answer":1,"answerText":"서술형이면 모범답안","evidence":"정답 근거","teacherGuide":{"flow":"전체 논리 흐름 한 줄","roles":["문장별 역할"],"clues":["연결 단서"],"structure":["논리 구조 태그"]}}]}. 객관식은 정확히 5지선다, 정답은 1~5 숫자. 서술형은 options=[] 가능. 같은 정답 패턴만 반복하지 말 것. 제공되지 않은 원문 사실을 지어내지 말 것. 과거 출제와 발문만 바꾼 실질적 동일문항, 동일 정답근거, 동일 오답논리를 피하라.

[선지 설계 엔진]
목표는 단순히 헷갈리게 하는 것이 아니라 학생의 정확한 독해·문법 이해를 변별하는 것이다. 먼저 각 문항의 평가 능력과 정답 근거를 확정한 뒤 선지를 만든다. 정답은 지문의 핵심을 정확히 재진술하되 가능하면 원문을 그대로 복사하지 않는다. 오답은 다음 전략 중 문항에 적합한 서로 다른 전략을 사용한다: 부분 일치형(사실 일부는 맞지만 핵심을 대표하지 못함), 범위 왜곡형(some/all, often/always, 특정/일반 등 범위 미세 변형), 인과관계 왜곡형, 주체·대상·비교대상 교체형, 조건 누락·변형형, 초점 이동형(언급은 되었으나 중심이 아님), 논리 반전형, 과잉 추론형(그럴듯하지만 지문만으로 단정 불가), 상식 유혹형(현실적으로 가능하지만 지문 근거 없음), 키워드 유혹형(지문 어휘를 사용하되 전체 의미가 틀림), 관계 왜곡형(비교·대조·예시·양보·문제해결 관계 오독), 근접개념형, 문단 혼합형(서로 다른 문단 사실을 잘못 결합), 정답 근접형(대부분 맞지만 결정적 한 요소가 틀림).

[유형별 우선 전략]
주제·요지·제목·주장: 부분 일치/초점 이동/범위 왜곡/과잉 일반화/정답 근접형을 우선한다. 내용 일치·불일치·지칭: 주체·대상 교체/조건·수치·시점 변형/인과 변형/문단 혼합을 우선한다. 빈칸·함의: 가까운 개념/논리 관계 왜곡/문맥 방향 반전/정답 근접형을 우선한다. 순서·삽입·무관문장·요약: 연결어·지시어·논리 전개·문단 역할을 실제로 이해해야 구별되게 한다. 어휘: 품사가 안 맞는 황당한 단어가 아니라 같은 의미장·문맥에서 경쟁 가능한 어휘를 사용한다. 어법·문법: 목표 문법 체계 안의 실제 학습자 혼동을 사용하고, 목표 외의 우연한 문법 오류를 힌트로 만들지 않는다. 관계사는 who/which/that/what/whose/where 등 실제 혼동군, 시제는 문맥의 시간관계, 준동사는 동사별 결합과 의미 차이처럼 해당 문법의 오개념을 반영한다.

[교사용 논리 분석]
지문이 있는 독해 문항에는 teacherGuide를 작성한다. flow에는 글 전체 전개를 MAIN→SUPPORT, GENERAL→SPECIFIC, OLD→NEW, CAUSE→EFFECT, PROBLEM→SOLUTION, CLAIM→EVIDENCE, CONTRAST, CONCESSION→CLAIM, QUESTION→ANSWER, PROCESS/SEQUENCE, CONDITION→RESULT, PURPOSE→METHOD, PHENOMENON→EXPLANATION, EXAMPLE→INFERENCE, EXPECTATION→REALITY, COMMON VIEW→CORRECTION, SUMMARY/CONCLUSION 등의 태그를 이용해 한 줄로 요약한다. roles에는 문장 번호별 역할을 한국어로 간결히 적고, clues에는 연결사·지시어·반복어/동의어·관사 a→the·시제·대명사 지시·논리 연결 등 실제 연결 단서를 적는다. structure에는 핵심 MAIN/SUPPORT 및 GENERAL/SPECIFIC 등 구조를 적는다. 근거가 없는 구조 태그는 억지로 붙이지 않는다. 문법 단독 문항은 teacherGuide를 비워도 된다.

[공정성 규칙]
정답과 오답의 길이·문체·구체성·문법적 완성도를 평행하게 맞춘다. 정답만 유난히 길거나 자세하거나 원문과 어휘가 겹쳐 티 나게 하지 않는다. always/never 같은 절대어, 단순 부정, 엉뚱한 소재만으로 쉽게 제거되는 오답을 남발하지 않는다. 모든 오답은 왜 틀렸는지 지문 또는 목표 문법으로 설명 가능해야 하며 정답은 정확히 하나여야 한다. 네 오답이 동일한 함정 논리를 반복하지 않게 한다. 난이도를 올릴 때는 어려운 단어를 무작정 쓰지 말고 정답과 오답 사이의 의미 거리를 줄인다.`;
let prompt;if(mode==='weekly'){prompt=`WEEKLY TEST를 생성하라. 대상 ${b.grade}, 난이도 ${b.difficulty}, 목표 총 ${b.total}문항.\n문법 선택: ${(b.grammar||[]).join(', ')}\n문법 형식: ${(b.grammarFormats||[]).join(', ')}\n문법 목표 문항수: ${b.grammarCount||0}\n수업 지문/예문:\n${String(b.passage||'').slice(0,35000)}\n\n모의고사 변형 유형: ${(b.mockTypes||[]).join(', ')}\n모의고사 변형 목표 문항수: ${b.mockCount||0}\n모의고사 원자료:\n${String(b.mockText||'').slice(0,35000)}\n\n규칙: 선택한 문법만 문법문제로 출제한다. 모의고사 자료가 있으면 원본 문항을 살짝 고치거나 선지만 교체하는 방식은 금지한다. 원자료의 지문과 핵심 내용을 출제 재료로 사용하되, 원문 문항의 발문·정답 위치·정답 근거 포인트·오답 논리를 그대로 재사용하지 말고 새로운 평가 포인트를 찾아 독립적인 새 문항으로 재설계한다. 가능하면 원본과 다른 선택 유형(빈칸/순서/삽입/어휘/어법/내용일치/요약/제목 등)으로 전환하고, 같은 유형을 선택했더라도 묻는 핵심과 선지 논리를 새로 설계한다. 학생이 원본 문제를 외웠다는 이유만으로 정답을 맞힐 수 없어야 한다. 단, 지문 자체를 변형해야 하는 유형 외에는 원문 사실과 의미를 훼손하지 않는다. 해석형을 만들 경우 실제 제공 문장을 사용한다.`}else{prompt=`SIMUL TEST를 생성하라. 학교 ${b.school||''}, ${b.grade}, ${b.term||''}, 총 ${b.total}문항, 난이도 ${b.difficulty}.\n학교 기출 분석/추가 지시:\n${String(b.style||'').slice(0,15000)}\n\n기출 시험지 원문(형식 참고):\n${String(b.pastText||'').slice(0,25000)}\n\n이번 시험범위 지문(내용 출처):\n${String(b.rangeText||'').slice(0,50000)}\n\n선택 출제 유형: ${(b.types||[]).join(', ')}\n서술형 비율: ${b.written}.\n규칙: 학교 기출은 내용 복사가 아니라 발문/선택지/서술형/문항 구성의 형식을 분석해 재현한다. 문제 내용과 정답 근거는 반드시 이번 시험범위에서 가져온다. ${b.preserveText?'시험범위 원문 문장을 임의로 고치지 말고 필요한 경우 그대로 인용한다.':'문항 목적상 최소한의 변형을 허용한다.'} 선택한 유형을 우선 사용한다.`}
prompt+=`\n\n[이미 출제된 문제 - 재출제 금지]\n${old||'없음'}`;const txt=await aiText(base,prompt);const data=cleanJson(txt);let qs=Array.isArray(data.questions)?data.questions:[];if(!qs.length)throw Error("생성된 문제가 없습니다.");if(b.total&&qs.length>b.total)qs=qs.slice(0,b.total);
// 2차 선지 검수: 생성과 검수를 분리해 뻔한 오답/복수정답/길이 힌트를 한 번 더 제거한다.
const mc=qs.map((q,i)=>({i,type:q.type,prompt:q.prompt,passage:q.passage,options:q.options,answer:q.answer,evidence:q.evidence})).filter(x=>Array.isArray(x.options)&&x.options.length===5);
if(mc.length){try{const qaInput=`다음 객관식 문항을 '선지 설계 → 오답 사유 태깅 → 공정성 검수' 순서로 독립 검수하라. 문제의 평가 목표와 정답 근거는 유지한다. 정답 자체가 근거와 충돌할 때만 정답 번호를 수정한다.

[오답 전략 태그]
PARTIAL=부분 일치, SCOPE=범위 왜곡, CAUSE=인과 왜곡, ROLE=주체/대상 교체, CONDITION=조건 변형, FOCUS=초점 이동, REVERSAL=논리 반전, OVERINFER=과잉 추론, COMMONSENSE=상식 유혹, KEYWORD=키워드 유혹, RELATION=관계 왜곡, NEAR_CONCEPT=근접개념, MIXED_DETAIL=문단/세부 혼합, NEAR_CORRECT=정답 근접형, GRAMMAR_CONFUSION=동일 문법체계 오개념.

[유형별 기준]
- 주제/요지/제목/주장: PARTIAL, FOCUS, SCOPE, OVERINFER, NEAR_CORRECT 중심.
- 내용 일치/불일치/지칭: ROLE, CONDITION, CAUSE, MIXED_DETAIL 중심.
- 빈칸/함의: NEAR_CONCEPT, RELATION, REVERSAL, NEAR_CORRECT 중심.
- 순서/삽입/무관문장/요약: 연결어, 지시어, 논리 전개, 문단 역할을 근거로 설계.
- 어휘: 같은 품사와 의미장 안에서 실제 경쟁 가능한 어휘 사용.
- 어법/문법: 목표 문법 안의 실제 오개념만 사용. 다른 우연한 오류로 답을 노출하지 말 것.

[최종 검수]
1. 각 오답은 제공된 지문/목표 문법으로 틀린 이유를 한 문장으로 설명할 수 있어야 한다.
2. 정답은 정확히 하나여야 하고, 오답 4개는 가능하면 서로 다른 태그를 사용한다.
3. 정답만 길거나 구체적이거나 원문 표현과 과도하게 일치하지 않게 한다.
4. 단순 부정, 절대어, 엉뚱한 소재, 품사 불일치처럼 형태만 보고 제거 가능한 오답은 교체한다.
5. 난이도는 어휘 난삽화가 아니라 정답과 오답의 의미적 근접성으로 조절한다.
6. 정답과 선지 전체의 길이·문체·문장구조를 최대한 평행하게 한다.
7. 모든 선지가 실제 시험지에 바로 들어갈 자연스러운 영어/한국어인지 확인한다.

반드시 JSON만 출력:
{"items":[{"i":0,"options":["...","...","...","...","..."],"answer":1,"tags":["CORRECT","PARTIAL","SCOPE","CAUSE","FOCUS"],"reasons":["정답 근거","오답 이유","오답 이유","오답 이유","오답 이유"],"quality":{"singleAnswer":true,"balanced":true,"sourceGrounded":true}}]}
options/tags/reasons는 각각 정확히 5개이고 같은 인덱스끼리 대응해야 한다. 정답 위치의 tag는 CORRECT로 한다.

문항:
${JSON.stringify(mc).slice(0,70000)}`;
const qa=cleanJson(await aiText("너는 한국 중고등학교 영어시험의 선택지 설계·검수 전문가다. 단순히 헷갈리게 하지 말고, 평가하려는 능력에서 발생하는 실제 오개념을 이용해 변별력 있고 공정한 5지선다를 만든다. 모든 오답은 틀린 이유가 설명 가능해야 한다.",qaInput));
for(const z of (qa.items||[])){const q=qs[Number(z.i)];if(q&&Array.isArray(z.options)&&z.options.length===5){q.options=z.options;if(Number(z.answer)>=1&&Number(z.answer)<=5)q.answer=Number(z.answer);q.choiceMeta={tags:Array.isArray(z.tags)?z.tags:[],reasons:Array.isArray(z.reasons)?z.reasons:[],quality:z.quality||{}}}}
}catch(e){console.error("distractor QA skipped:",e.message)}}
const source=mode==='weekly'?String(b.passage||'')+String(b.mockText||''):String(b.rangeText||'');await saveHistory({school,grade:b.grade||'',mode,sourceHash:hash(source)},qs);res.json({mode,title:data.title||(mode==='weekly'?'WEEKLY TEST':'SIMUL TEST'),school,questions:qs})}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/history",async(q,s)=>{try{if(pool){const r=await pool.query("select * from exam_history order by created_at desc limit 300");return s.json(r.rows)}s.json(mem.history)}catch(e){s.status(500).json({error:e.message})}});

const R={};
app.post("/api/voca/room",async(req,res)=>{
 let c; do{c=String(Math.floor(100000+Math.random()*900000))}while(R[c]);
 let sets=req.body.sets||[]; R[c]={sets,i:-1,s:{},h:null,timer:null,nextTimer:null,deadline:0,locked:false,className:req.body.className||""};
 let u=req.protocol+"://"+req.get("host")+"/student.html?room="+c;
 res.json({c,u,qr:await QRCode.toDataURL(u,{width:300,margin:1})});
});
app.get("/api/voca/stats",async(q,s)=>{
 try{
  if(pool){let r=await pool.query("select * from vocab_attempts order by created_at desc limit 500");return s.json(r.rows)}
  s.json(mem.vocabAttempts);
 }catch(e){s.status(500).json({error:e.message})}
});
async function saveAttempt(st,r){
 const wrong=st.wrong||[];
 if(pool) await pool.query("insert into vocab_attempts(student,class_name,set_name,total,correct,wrong_words) values($1,$2,$3,$4,$5,$6)",
 [st.n,r.className,st.setName,st.total,st.correct,JSON.stringify(wrong)]);
 else mem.vocabAttempts.unshift({student:st.n,class_name:r.className,set_name:st.setName,total:st.total,correct:st.correct,wrong_words:wrong,created_at:new Date().toISOString()});
}
io.on("connection",s=>{
 s.on("host",c=>{if(!R[c])return;s.join(c);R[c].h=s.id});
 s.on("getSets",c=>{let r=R[c];if(!r)return s.emit("bad");s.emit("sets",r.sets.map(z=>({id:z.id,name:z.name})))});
 s.on("join",x=>{let r=R[x.c];if(!r)return s.emit("bad");let set=r.sets.find(z=>z.id===x.setId);if(!set)return s.emit("badSet");
   r.s[s.id]={n:(x.n||"학생").slice(0,20),setId:set.id,setName:set.name,score:0,correct:0,total:set.q.length,a:false,wrong:[],started:Date.now()};s.join(x.c);s.emit("ok",{setName:set.name});emitLobby(r)});
 function emitLobby(r){if(r.h)io.to(r.h).emit("names",Object.values(r.s))}
 function clear(r){clearTimeout(r.timer);clearTimeout(r.nextTimer);r.timer=r.nextTimer=null}
 function maxLen(r){return Math.max(0,...r.sets.map(z=>z.q.length))}
 function sendQuestion(r){const n=r.i+1;Object.entries(r.s).forEach(([id,st])=>{let set=r.sets.find(z=>z.id===st.setId),q=set?.q[r.i];
   if(q)io.to(id).emit("q",{n,total:set.q.length,t:q.t,o:q.o,deadline:r.deadline,setName:set.name});else st.a=true});
   if(r.h)io.to(r.h).emit("hostRound",{n,total:maxLen(r),deadline:r.deadline});
 }
 function next(c){let r=R[c];if(!r||r.locked)return;r.locked=true;clear(r);r.i++;Object.values(r.s).forEach(st=>st.a=false);
   if(r.i>=maxLen(r)){finish(r);r.locked=false;return}
   r.deadline=Date.now()+10000;sendQuestion(r);
   r.timer=setTimeout(()=>{r.timer=null;io.to(c).emit("timeup");r.nextTimer=setTimeout(()=>next(c),900)},10000);r.locked=false;
 }
 function active(r){return Object.values(r.s).filter(st=>r.sets.find(z=>z.id===st.setId)?.q[r.i])}
 function allDone(r){let a=active(r);return a.length>0&&a.every(st=>st.a)}
 async function finish(r){
   let all=Object.values(r.s).sort((a,b)=>b.correct-a.correct||b.score-a.score||(a.started-b.started));
   for(const st of all){try{await saveAttempt(st,r)}catch(e){console.error(e)}}
   if(r.h)io.to(r.h).emit("endHost",all);
   Object.keys(r.s).forEach(id=>io.to(id).emit("endStudent",{overall:all.slice(0,3)}));
 }
 s.on("start",next);s.on("next",next);
 s.on("ans",x=>{let r=R[x.c],st=r?.s[s.id];if(!st||st.a||Date.now()>r.deadline)return;let set=r.sets.find(z=>z.id===st.setId),q=set?.q[r.i];if(!q)return;
   st.a=true;let good=Number(x.a)===Number(q.a);if(good){st.score+=100;st.correct++}else st.wrong.push({word:q.word||q.t,correct:q.o?.[q.a-1]||q.a});
   s.emit("result",{good,correct:q.a});if(r.h)io.to(r.h).emit("scores",{students:Object.values(r.s),answered:active(r).filter(v=>v.a).length,total:active(r).length});
   if(allDone(r)){clear(r);io.to(x.c).emit("allAnswered");r.nextTimer=setTimeout(()=>next(x.c),1200)}
 });
 s.on("disconnect",()=>{for(const c in R){if(R[c].s[s.id]){delete R[c].s[s.id];emitLobby(R[c])}}});
});
srv.listen(process.env.PORT||3000);
