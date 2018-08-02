'use strict';
var CryptoJS = require("crypto-js");
var express = require("express");
var bodyParser = require('body-parser');
var WebSocket = require("ws");

var http_port = process.env.HTTP_PORT || 3001;
var p2p_port = process.env.P2P_PORT || 6001;
var initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : [];

class Block {   // 수정 요망
    //constructor(index, blockHash, previousHash, merkleRoot, timestamp, difficulty, nonce, tx_counter, [transactions]) {
    constructor(index, previousHash, timestamp, data, hash, difficulty, nonce) {
        this.index = index;
        this.previousHash = previousHash.toString();
        this.timestamp = timestamp;
        this.data = data;
        this.hash = hash.toString();
        // added data field
        this.difficulty = difficulty;
        this.nonce = nonce;
    }
}

class Transaction {
    constructor(transactionHash,in_counter, inputs, out_counter, outputs) {   // 수정 요망
        this.in_counter = in_counter;
        for(var i=0; i<in_counter; i++){
            this.inputs[i].txid = inputs[i].txid.toString();
            this.inputs[i].sequence = inputs[i].sequence;
        }
        for(var i=0; i<out_counter; i++){
            this.outputs[i].value = outputs[i].value;
            this.outputs[i].sig = outputs[i].sig.toString();
        }
        this.out_counter = out_counter;
        this.outputs = [outputs];
        //this.transactionHash = CryptoJS.SHA256(in_counter + [inputs] + out_counter + [outputs]).toString();
        //calculate transaction hash directly, not using passed parameter
        this.transactionHash = transactionHash.toString();
    }
}

var sockets = [];
var MessageType = {
    QUERY_LATEST: 0,
    QUERY_ALL: 1,
    RESPONSE_BLOCKCHAIN: 2
};

var getGenesisBlock = () => {
    return new Block(0, "0", 1465154705, "my genesis block!!", "816534932c2b7154836da6afc367695e6337db8a921823784c14378abed4f7d7", "04e940487dfe77385a882ca3e6fee5bb8e621ae1c891f44282dfa29d5ab161e6", 1234);
};

var memPool = [];
var UTXOsets = [];

var initMemPool = () => {
    memPool.push({transactionHash:"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",in_counter:1,inputs:
    [{txid: "84909c7ba11f17777bb9eda44b77e48fbe77e23797ed25a711507a41288e7133", sequence:3}],out_counter:
    1,outputs:[{value:0.5,sig:"656c61a876b3c6118e25b49adcaeda2b449a256a843c8e2c74f02553c828699b"}]});

    memPool.push({transactionHash:"a441b15fe9a3cf56661190a0b93b9dec7d04127288cc87250967cf3b52894d11",in_counter:1,inputs:
    [{txid:"82ee2898a1d083a3ce2a8e8d2f44be000a4f660a42df42ce8f20c857f3aefefa",sequence:0}],out_counter:
    1,outputs:[{value:0.5,sig:"e4bda23f74a779e9ad8216e38de099d1a73538476ba6459fb8c70757280d8374"}]});
    

    memPool.push({transactionHash:"0e1737cc61216df82ad94125c977e70a8fd916c3f67a655a815ee199b79eed20",in_counter:1,inputs:
    [{txid: "41313f3e4051927cac9f41d6d272a9635100fc294a1ece335b67cc57ac2eae0f", sequence: 0}],out_counter:
    2,outputs:[{value:1.2,sig:"bb58e7826653e1a7cda3992e4f78dd34f1a4475394ee035dac86d1c427078caa"},{value:0.5,sig:"8706df381667b49358919ef5dd848ca1998179a4ed07f9912a40322cc0460e1b"}]});
}

var blockchain = [getGenesisBlock()];

var initHttpServer = () => {
    var app = express();
    app.use(bodyParser.json());

    app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain)));
    app.get('/mempool', (req, res) => res.send(JSON.stringify(memPool)));
    app.post('/mineBlock', (req, res) => {
        var newBlock = generateNextBlock(req.body.data);
        addBlock(newBlock);
        broadcast(responseLatestMsg());
        console.log('block added: ' + JSON.stringify(newBlock));
        res.send();
    });
    app.get('/peers', (req, res) => {
        res.send(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort));
    });
    app.post('/addPeer', (req, res) => {
        connectToPeers([req.body.peer]);
        res.send();
    });
    app.post('/newTransaction', (req, res) => {
        var tmp = isValidTransaction(req.body);
        if(tmp){
            // add new transaction to memPool
            addToMempool(req.body);
            addToUTXO(req.body);
            res.send("Valid Transaction");
        }
        else{
            res.send("Invalid Transction");
        }
    });

    //삭제 요망
    app.post('/isValidNewBlock', (req, res) => {
        var tmp = isValidNewBlock(req.body,blockchain[0]);
        if(tmp){
            // add new block to blockchain
            // add outputs to UTXO set
            res.send("Valid Block");
        }
        else{
            res.send("Invalid Block");
        }
    });
    app.listen(http_port, () => console.log('Listening http on port: ' + http_port));
};
var addToMempool = (newTransaction) => {
    memPool.push({transactionHash:newTransaction.transactionHash,in_counter:newTransaction.in_counter,inputs:
    newTransaction.inputs,out_counter:
    newTransaction.out_counter,outputs:newTransaction.outputs});
}
var addToUTXO = (newTransaction) => {
    UTXOsets.push(newTransaction.outputs);
}
var isValidTransaction = (newTransaction) => {
    // check if every data field are non-empty
    if (newTransaction.transactionHash == null || // 나중에 제거하기
        newTransaction.in_counter == null || 
        newTransaction.inputs == null || 
        newTransaction.out_counter == null ||
         newTransaction.outputs == null) {
        console.log("Invalid transacion format");
        return false;
    }

    // check if is there any negative outputs
    for(var i=0; i<newTransaction.out_counter; i++ ){
        if(newTransaction.outputs[i].value < 0){
            console.log("Negative output");
            return false;
        }
    }

    // 0 < sum of outputs < 21,000,000
    var sum = 0;
    for(var i=0; i<newTransaction.out_counter; i++ )
        sum += newTransaction.outputs[i].value;    
    if(sum<=0||sum>21000000){
        console.log("Sum of outputs must be 0 ~ 21,000,000")
        return false;
    }

    // check if hash is 0 and sequence(index) is negative
    for(var i=0; i<newTransaction.in_counter; i++ ){   
        if(newTransaction.inputs[i].txid == "0" || newTransaction.inputs[i].sequence < 0)   {
            
            return false;
        }
    }
    
    
    sum = 0;
    // check if inputs of transaction exist in memPool or main block
    for(var i=0; i<newTransaction.in_counter; i++){
        // check memPool
        var flag = false;
        for(var j=0; j<memPool.length; j++){
            if(newTransaction.inputs[i].txid == memPool[j].transactionHash){
                flag = true;
                // add value of outputs
                sum += memPool[j].outputs[newTransaction.inputs[i].sequence].value;
                break;
            }
        }
        if(flag)
            continue;
        // check main block branch

        if(!flag){
            console.log("no memPool");
            return false;
        }
    }

    // check if sum of input values are less than sum of outputs
    for(var i=0; i<newTransaction.out_counter; i++)
        sum -= newTransaction.outputs[i].value;
    if(sum<0)
        return false;

    // check if double-spended in memPool
    // 너무 무식하게 코딩함 수정좀
    for(var i=0; i<newTransaction.in_counter; i++){
        for(var j=0; j<memPool.length; j++){
            for(var k=0; k<memPool[j].in_counter; k++){
                if(newTransaction.inputs[i].txid == memPool[j].inputs[k].txid){
                    return false;
                }
            }
        }
    }
    return true;
};

var initP2PServer = () => {
    var server = new WebSocket.Server({port: p2p_port});
    server.on('connection', ws => initConnection(ws));
    console.log('listening websocket p2p port on: ' + p2p_port);

};

var initConnection = (ws) => {
    sockets.push(ws);
    initMessageHandler(ws);
    initErrorHandler(ws);
    write(ws, queryChainLengthMsg());
};

var initMessageHandler = (ws) => {
    ws.on('message', (data) => {
        var message = JSON.parse(data);
        console.log('Received message' + JSON.stringify(message));
        switch (message.type) {
            case MessageType.QUERY_LATEST:
                write(ws, responseLatestMsg());
                break;
            case MessageType.QUERY_ALL:
                write(ws, responseChainMsg());
                break;
            case MessageType.RESPONSE_BLOCKCHAIN:
                handleBlockchainResponse(message);
                break;
        }
    });
};

var initErrorHandler = (ws) => {
    var closeConnection = (ws) => {
        console.log('connection failed to peer: ' + ws.url);
        sockets.splice(sockets.indexOf(ws), 1);
    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
};


var generateNextBlock = (blockData) => {
    var previousBlock = getLatestBlock();
    var nextIndex = previousBlock.index + 1;
    var nextTimestamp = new Date().getTime() / 1000;
    var nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData);
    //return new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nextHash);
    return new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nextHash, "0547e56d1e434eca972617295fe28c69a4e32b259009c261952130078608371ac", 34583);
};


var calculateHashForBlock = (block) => {
    return calculateHash(block.index, block.previousHash, block.timestamp, block.data, block.difficulty, block.nonce);
};

var calculateHash = (index, previousHash, timestamp, data, difficulty, nonce) => {
    return CryptoJS.SHA256(index + previousHash + timestamp + data + difficulty + nonce).toString();
};

var addBlock = (newBlock) => {
    if (isValidNewBlock(newBlock, getLatestBlock())) {
        blockchain.push(newBlock);
    }
};



var isValidNewBlock = (newBlock, previousBlock) => {
    console.log(newBlock);
    // check if standard format
    if(newBlock.index == null || 
        newBlock.previousBlock == null ||
        newBlock.timestamp == null ||
        newBlock.data == null ||
        newBlock.difficulty == null ||
        newBlock.nonce == null){
        console.log('invalid block format');
        return false;
    }

    // chekc if difficulty is valid
    // not yet

    // check if transactionHash < difficulty
    var tmp = parseInt(newBlock.difficulty,16);
    var expo = tmp / 16777216;
    var coef = tmp % 16777216 - 3;
    var target_difficulty = coef * Math.pow(2,coef);
    if(calculateHashForBlock(newBlock)>=target_difficulty){
        console.log('invalid nonce');
        return false;
    }

    // check if within 2 hours
    if(newBlock.timestamp + 72000 < Math.floor(new Date().getTime() / 1000)){
        console.log('invalid timestamp(more than 2 hours)');
        return false;
    }

    // check if all transactions are valid
    // not yet

    // check block height
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('invalid index');
        return false;
    } 
    
    // check previous block hash ---------------------->should be revised!
    /*else if (previousBlock.hash !== newBlock.previousHash) {
        console.log('invalid previoushash');
        return false;
    }*/
    
    // check if block hash is right
    else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log(typeof (newBlock.hash) + ' ' + typeof calculateHashForBlock(newBlock));
        console.log('invalid hash: ' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash);
        return false;
    }
    return true;
};

var connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
        var ws = new WebSocket(peer);
        ws.on('open', () => initConnection(ws));
        ws.on('error', () => {
            console.log('connection failed')
        });
    });
};

var handleBlockchainResponse = (message) => {
    var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    var latestBlockHeld = getLatestBlock();
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            console.log("We can append the received block to our chain");
            blockchain.push(latestBlockReceived);
            broadcast(responseLatestMsg());
        } else if (receivedBlocks.length === 1) {
            console.log("We have to query the chain from our peer");
            broadcast(queryAllMsg());
        } else {
            console.log("Received blockchain is longer than current blockchain");
            replaceChain(receivedBlocks);
        }
    } else {
        console.log('received blockchain is not longer than current blockchain. Do nothing');
    }
};

var replaceChain = (newBlocks) => {
    if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
        console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
        blockchain = newBlocks;
        broadcast(responseLatestMsg());
    } else {
        console.log('Received blockchain invalid');
    }
};

var isValidChain = (blockchainToValidate) => {
    if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) {
        return false;
    }
    var tempBlocks = [blockchainToValidate[0]];
    for (var i = 1; i < blockchainToValidate.length; i++) {
        if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
            tempBlocks.push(blockchainToValidate[i]);
        } else {
            return false;
        }
    }
    return true;
};

var getLatestBlock = () => blockchain[blockchain.length - 1];
var queryChainLengthMsg = () => ({'type': MessageType.QUERY_LATEST});
var queryAllMsg = () => ({'type': MessageType.QUERY_ALL});
var responseChainMsg = () =>({
    'type': MessageType.RESPONSE_BLOCKCHAIN, 'data': JSON.stringify(blockchain)
});
var responseLatestMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify([getLatestBlock()])
});

var write = (ws, message) => ws.send(JSON.stringify(message));
var broadcast = (message) => sockets.forEach(socket => write(socket, message));

connectToPeers(initialPeers);
initHttpServer();
initP2PServer();
initMemPool();
