const fs=require("fs"),path=require("path");const {Kafka,logLevel}=require("kafkajs");
const env={};for(const l of fs.readFileSync(path.join(__dirname,"..",".env.aiven.local"),"utf8").split(/\r?\n/)){const i=l.indexOf("=");if(i>0)env[l.slice(0,i)]=l.slice(i+1);}
(async()=>{
 const kafka=new Kafka({clientId:"logsite",brokers:env.KAFKA_BROKERS.split(","),
  ssl:{ca:[fs.readFileSync(path.join(__dirname,"..",".certs","ca.pem"),"utf8")],rejectUnauthorized:false},
  sasl:{mechanism:"scram-sha-256",username:env.KAFKA_USERNAME,password:env.KAFKA_PASSWORD},
  logLevel:logLevel.NOTHING,connectionTimeout:10000,retry:{retries:3}});
 const admin=kafka.admin();await admin.connect();
 console.log("CLUSTER",JSON.stringify(await admin.describeCluster()));
 await admin.disconnect();
 const producer=kafka.producer();await producer.connect();
 const key=`smoke-${Date.now()}`;
 const meta=await producer.send({topic:env.KAFKA_TOPIC,messages:[{key,value:JSON.stringify({id:key,code:"ERR_SMOKE",message:"sync aiven",ts:new Date().toISOString()})}]});
 await producer.disconnect();
 console.log("PRODUCED",JSON.stringify(meta));
 const consumer=kafka.consumer({groupId:`logsite-smoke-${Date.now()}`});
 await consumer.connect();await consumer.subscribe({topic:env.KAFKA_TOPIC,fromBeginning:true});
 const found=await new Promise(resolve=>{const timer=setTimeout(()=>resolve(null),20000);
  consumer.run({eachMessage:async({partition,message})=>{if(String(message.key)!==key)return;clearTimeout(timer);resolve({partition,offset:message.offset,value:JSON.parse(String(message.value))});}}).catch(()=>{});});
 await consumer.disconnect().catch(()=>{});
 console.log("CONSUMED",JSON.stringify(found));
 console.log("SYNC",found&&found.value.id===key?"OK":"FAIL");
 process.exit(found?0:1);
})().catch(e=>{console.error("FAIL",e.message);process.exit(1);});
