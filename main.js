'use strict';
var CryptoJS = require("crypto-js");
var express = require("express");
var bodyParser = require('body-parser');
var WebSocket = require("ws");

//teamTx

let elliptic = require('elliptic');
let sha3 = require('js-sha3');
let ec = new elliptic.ec('secp256k1');

let keyPair = ec.genKeyPair();
let privKey = keyPair.getPrivate("hex");
let pubKey = keyPair.getPublic();

let local_host = 3001;

var http_port = process.env.HTTP_PORT || 3001;
var p2p_port = process.env.P2P_PORT || 6001;
var initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : [];

// teamb
class Block {

    constructor(index, previousHash, timestamp, data, hash, targetvalue) {

        this.index = index;
        this.previousHash = previousHash.toString();
        this.timestamp = timestamp;
        this.data = data;
        this.hash = hash.toString();
        this.nonce = 0;
        this.targetvalue = targetvalue;
        this.tx_set = [];
        this.root = "";
    }
}

//teamb
class Merkle_Tree {

    constructor() {

        this.index = 0;
        this.node_values = [];
        this.root = "";

    }
}


class Vin {
    constructor(tx_id, index, unlock) {
        this.tx_id = tx_id; //transaction hash
        this.index = index; //inputTx의 index임.!!!!!이게 문제였음 0811
        this.unlock = unlock;
    }
}
class Vout {
    constructor(value, lock) {
        this.value = value;     //amount
        this.lock = lock;       //받는사람의 public key  
    }
}

class Transaction {
    constructor(sender, value, pubKey, in_counter, out_counter, vin, vout) {   // 수정 요망
        var SumString = []
        this.in_num = in_counter;
        this.vin = vin;
        this.out_num = out_counter;
        this.vout = vout;
        for (var i = 0; i < in_counter; i++) {
            SumString.concat(String(vin[i].tx_id), String(vin[i].index), String(vin[i].unlock));
        }
        for (var i = 0; i < out_counter; i++) {
            SumString.concat(String(vout[i].value), String(vout[i].lock));
        }
        
        SumString.concat(String(value), String(in_counter), String(out_counter));
        this.tx_id = sha3.keccak256(SumString);
    }
}

var A = [];
A.push(new Vout(10, 3001));
var coinBaseTx = new Transaction(0, 0, pubKey, 0, 1, {}, A);

class UTXO {
    constructor(txOutid, index, address, amount) {
        this.txOutid = txOutid;
        this.index = index;
        this.address = address;
        this.amount = amount;
    }
}


var sockets = [];

var MessageType = {
    QUERY_LATEST: 0,
    QUERY_ALL: 1,
    RESPONSE_BLOCKCHAIN: 2,
    RESPONSE_Transaction: 3

};

var getGenesisBlock = () => {
    return new Block(0, "0", 1465154705, "my genesis block!!", "816534932c2b7154836da6afc367695e6337db8a921823784c14378abed4f7d7", "04e940487dfe77385a882ca3e6fee5bb8e621ae1c891f44282dfa29d5ab161e6", 1234);
};

var memPool = [];
var MyUTXOsets = [];
var UTXOsets = [];
var mk_db = []; // teamb

var blockchain = [getGenesisBlock()];

var initHttpServer = () => {
    var app = express();
    app.use(bodyParser.json());

    app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain)));

    app.get('/UTXOs', (req, res) => res.send(JSON.stringify(UTXOsets)));
    //동환0811
    app.get('/myUTXOs', (req, res) => res.send(JSON.stringify(MyUTXOsets)));

    app.post('/setGenesis', (req, res) => {  

        var a = blockchain.length;
        console.log(JSON.stringify(a));
        if (a != 0) console.log("gensis block exists");
        else {
            var currentTimestamp = new Date().getTime() / 1000;

            var new_block = new Block(a, "0", 0, req.body.data, "", 0, "0AAA");

            var blockHash = calculateHashForBlock(new_block);

            new_block.hash = blockHash.toString();

            blockchain.push(new_block);
        }
        res.send(JSON.stringify(blockchain));
    });

    app.post('/mineBlock', (req, res) => { 

        var newBlock = generateNextBlock(req.body.data, memPool); // Using req.body.data for labeling block

        console.log(JSON.stringify(memPool));

        addBlock(newBlock);
        broadcast(responseLatestMsg());
        res.send();

    });


    app.get('/peers', (req, res) => {
        res.send(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort));
    });
    app.post('/addPeer', (req, res) => {
        connectToPeers([req.body.peer]);
        res.send();
    });

    app.get('/transactions', (req, res) => res.send(JSON.stringify(memPool)));
    app.post('/newTransaction', (req, res) => {
        var newSender = req.body.sender;
        var newReceiver = req.body.receiver;
        var newValue = req.body.value;
        var newin_counter;
        var newout_counter;
        var newTransaction;
        
        //inputs는 Tx의 input들을 위한 임시 변수
        var inputs = new Array();
        var outputs = new Array();
        if ((newTransaction = UTXOtoInput(newTransaction, newSender, newReceiver, newValue, inputs, outputs, newin_counter, newout_counter)) == false) {
            res.end()
        } else {
            
            //tx풀에 추가.
            addTransaction(newTransaction);
            broadcast(responseTxMsg());

            console.log('New Tx: ' + JSON.stringify(newTransaction));

            //res.end();

            res.send();
        }
    });
    app.post('/isValidNewBlock', (req, res) => {
        var tmp = isValidNewBlock(req.body, blockchain[0]);
        if (tmp) {
            // add new block to blockchain
            // add outputs to UTXO set
            res.send("Valid Block");
        }
        else {
            res.send("Invalid Block");
        }
    });


    app.listen(http_port, () => console.log('Listening http on port: ' + http_port));
};

//0811동환
var TxToUTXO = (txOut_id, index, address, amount) => {
    var UTXO_tmp = new UTXO(txOut_id, index, address, amount);

    return UTXO_tmp;
}

// add UTXOs to UTXOset when block is added.
var addToUTXOset = (newBlock) => {

    var len = newBlock.tx_set.length;

    for (var i = 0 ; i < len ; i++) {
        var vout_len = newBlock.tx_set[i].out_num;
        for (var j = 0; j < vout_len; j++) {
            UTXOsets.push(TxToUTXO(newBlock.tx_set[i].tx_id, j, newBlock.tx_set[i].vout[j].lock, newBlock.tx_set[i].vout[j].value));
            if (newBlock.tx_set[i].vout[j].lock == local_host) {
                console.log("MyUTXOset is added!\n" + newBlock.tx_set[i]);
                MyUTXOsets.push(TxToUTXO(newBlock.tx_set[i].tx_id, j, newBlock.tx_set[i].vout[j].lock, newBlock.tx_set[i].vout[j].value));
            }
        }
    }
}
var popFromMempool = (newBlock, m_pool) =>{

    var len = newBlock.tx_set.length;
    var mlen = m_pool.length;

    for (var i = 0 ; i < len ;i++)
    {
        
        for (var j = 0 ; j < mlen ; j++)
        {
            if( newBlock.tx_set[i].tx_id == m_pool[j].tx_id )
            {
               var mm = m_pool.splice(j,1);
               mlen--;
               j--;
            }
        }
    }   

}


var isValidTransaction = (newTransaction) => {

    // check if is there any negative outputs
    for (var i = 0; i < newTransaction.out_num; i++) {
        if (newTransaction.outputs[i].value < 0) {
            console.log("Negative output");
            return false;
        }
    }

    // 0 < sum of outputs < 21,000,000
    var sum = 0;
    for (var i = 0; i < newTransaction.out_num; i++)
        sum += newTransaction.outputs[i].value;
    if (sum < 0 || sum > 21000000) {
        console.log("Sum of outputs must be 0 ~ 21,000,000" + sum)
        return false;
    }

    // check if hash is 0 and sequence(index) is negative
    for (var i = 0; i < newTransaction.in_num; i++) {
        if (newTransaction.inputs[i].tx_id == "0" || newTransaction.inputs[i].index < 0) {

            return false;
        }
    }
    sum = 0;
    // check if inputs of transaction exist in memPool or main block
    for (var i = 0; i < newTransaction.in_num; i++) {
        // check memPool
        var flag = false;
        for (var j = 0; j < memPool.length; j++) {
            if (newTransaction.inputs[i].tx_id == memPool[j].transactionHash) {
                flag = true;
                // add value of outputs
                sum += memPool[j].outputs[newTransaction.inputs[i].index].value;
                break;
            }
        }
        if (flag)
            continue;
        // check main block branch

        if (!flag) {
            console.log("no memPool");
            return false;
        }
    }

    // check if sum of input values are less than sum of outputs
    for (var i = 0; i < newTransaction.out_num; i++)
        sum -= newTransaction.outputs[i].value;
    if (sum < 0)
        return false;

    // check if double-spended in memPool
    for (var i = 0; i < newTransaction.in_num; i++) {
        for (var j = 0; j < memPool.length; j++) {
            for (var k = 0; k < memPool[j].in_counter; k++) {
                if (newTransaction.inputs[i].tx_id == memPool[j].inputs[k].tx_id) {
                    return false;
                }
            }
        }
    }
    return true;
};

var initP2PServer = () => {
    var server = new WebSocket.Server({ port: p2p_port });
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
            case MessageType.RESPONSE_Transaction:
                handleTxResponse(message);
                break;
                //mm
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

var UTXOtoInput = (newTransaction, sender, receiver, value, inputs, outputs, in_counter, out_counter) => {
    //sender,value,pubkey
    var myutxolen = MyUTXOsets.length;
    var sum = 0;
    var i;
    var diff = 0; //차액

    var out_counter;

    var tx_id;
    var index;
    var unlock;

    var vin_tmp = new Vin(NaN, NaN, NaN);
    in_counter = 0;

    var delete_indexes = [];

    for (i = 0; i < myutxolen; i++) {

        if (MyUTXOsets[i].address == sender) {

            if (sum < value) {

                tx_id = UTXOsets[i].tx_id;
                index = 0;
                unlock = sha3.keccak256(String(tx_id) + String(index));

                vin_tmp.tx_id = tx_id;
                vin_tmp.index = index;
                vin_tmp.unlock = unlock;

                inputs.push(vin_tmp);

                in_counter++;
                sum = sum + UTXOsets[i].amount;

                if (sum >= value)
                    break;

            }
        }
    }//i는 UTXOsets의 마지막 utxo의 인덱스입니다.

    for (var i = 0; i < in_counter; i++) {
        MyUTXOsets.shift();

    }

    if (sum < value) {
        return false;
    }
    else {
        diff = sum - value;
        if (diff == 0) {
            outputs.push(new Vout(value, receiver));
            out_counter = 1;
        } else {
            outputs.push(new Vout(value, receiver));
            outputs.push(new Vout(diff, sender));
            out_counter = 2;
        }
        newTransaction = new Transaction(sender, value, receiver, in_counter, out_counter, inputs, outputs);

        return newTransaction;
    }
}

// 블록 생성 부분 
var generateNextBlock = (blockData, m_pool) => {

    memPool.unshift(coinBaseTx);

    var previousBlock = getLatestBlock();

    var nextIndex = previousBlock.index + 1;

    var nextTimestamp = new Date().getTime() / 1000;

    var nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData);

    var new_block = new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nextHash, "0AAA");

    var transaction_num = 0;

    var block_transactions = [];

    while (transaction_num <= 4 && m_pool.length != 0) { // assume block size is 3 transaction

        transaction_num += 1;

        var new_transaction = m_pool.shift();

        block_transactions.push(new_transaction);

    }


    new_block.tx_set = block_transactions;

    makemerkletree(new_block, new_block.tx_set);

    ProofofWork(new_block);

    return new_block;

};


var makemerkletree = (block, block_Transactions) => { // make merkle tree node's value 

    var index_s = 0;
    var index_e = 0;
    var mk_vals = new Merkle_Tree();

    mk_vals.index = block.index;

    for (var i in block_Transactions) {

        var tx_st = JSON.stringify(block_Transactions[i]);
        var h_val = CryptoJS.SHA256(tx_st).toString();
        mk_vals.node_values.push(h_val);

    }

    index_s = 0;
    index_e = block_Transactions.length;

    while (index_s + 1 != index_e) {

        for (var i = index_s; i < index_e; i = i + 2) {
            if (i + 1 < index_e) {

                var h_val = CryptoJS.SHA256(mk_vals.node_values[i] + mk_vals.node_values[i + 1]).toString();
                mk_vals.node_values.push(h_val);

            }
            else {

                var h_val = CryptoJS.SHA256(mk_vals.node_values[i]).toString();
                mk_vals.node_values.push(h_val);
            }
        }
        index_s = index_e;
        index_e = mk_vals.node_values.length;
    }
    block.root = mk_vals.node_values[index_s];

    console.log(mk_vals.node_values);
}


var ProofofWork = (block) => { // Proof of Work 완료

    var h_val;
    while (1) {

        h_val = CryptoJS.SHA256(block.root + (block.index).toString() + block.data + (block.nonce).toString()).toString();

        var res_val = h_val.substring(0, 3);

        if (res_val < block.targetvalue) break;

        block.nonce += 1;
    }

}


//teamTx

var generateNewTransaction = (sender, receiver, amount, pubKey, in_counter, out_counter, transactionHash, inputs, outputs) => {
    var aTransaction = new Transaction(sender, receiver, amount, pubKey, in_counter, out_counter, transactionHash, inputs, outputs); // TxHash, input_counter,inputs, output_counter, outputs
    return aTransaction;
};

var calculateHashForBlock = (block) => {
    return calculateHash(block.index, block.previousHash, block.timestamp, block.data);
};

var calculateHash = (index, previousHash, timestamp, data, difficulty, nonce) => {
    return CryptoJS.SHA256(index + previousHash + timestamp + data).toString();
};

var addBlock = (newBlock) => {
    if (isValidNewBlock(newBlock, getLatestBlock())) {
        //we have to add utxo set Txs in block.
        addToUTXOset(newBlock);    
        popFromMempool(newBlock,memPool);
        blockchain.push(newBlock);
    }

};

//teamTx
var addTransaction = (newTransaction) => {
    //if (isValidTransaction(newTransaction)) {
    memPool.push(newTransaction);
    //}
}

var isValidNewBlock = (newBlock, previousBlock) => {
    //console.log(newBlock);
    // check if standard format
    if (newBlock.index == null ||
        newBlock.previousHash == null ||
        newBlock.timestamp == null ||
        newBlock.data == null ||
        newBlock.hash == null ||
        newBlock.targetvalue == null ||
        newBlock.nonce == null) {
        console.log('invalid block format');
        return false;
    }

    // chekc if difficulty is valid
    // not yet

    // check if transactionHash < difficulty
    var tmp = parseInt(newBlock.difficulty, 16);
    var expo = tmp / 16777216;
    var coef = tmp % 16777216 - 3;
    var target_difficulty = coef * Math.pow(2, coef);
    if (calculateHashForBlock(newBlock) >= target_difficulty) {
        console.log('invalid nonce');
        return false;
    }

    // check if within 2 hours
    if (newBlock.timestamp + 72000 < Math.floor(new Date().getTime() / 1000)) {
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

//teamTx
//
var handleTxResponse = (message) => {
    var receivedTx = JSON.parse(message.data).sort((t1, t2) => (t1.index - t2.index));

    var receivedTx_A = JSON.stringify(receivedTx[0]);
    receivedTx_A = JSON.parse(receivedTx_A);
    var receivedTx_A = receivedTx[0];

    memPool.push(receivedTx_A);
}

//


var handleBlockchainResponse = (message) => {
    var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    var latestBlockHeld = getLatestBlock();
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            console.log("We can append the received block to our chain");
           // blockchain.push(latestBlockReceived);
            addBlock(latestBlockReceived);
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



var isValidChain = (blockchainToValidate) => { // Optimazation
    if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) { // 상연아!!!
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
var getLatestTx = () => memPool[memPool.length - 1];

var queryChainLengthMsg = () => ({ 'type': MessageType.QUERY_LATEST });
var queryAllMsg = () => ({ 'type': MessageType.QUERY_ALL });
var responseChainMsg = () =>({
    'type': MessageType.RESPONSE_BLOCKCHAIN, 'data': JSON.stringify(blockchain)
});
var responseLatestMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify([getLatestBlock()])
});

/* 
 *  message reqest for new transaction occured. 
 *  teamTx
*/
var responseTxMsg = () => ({

    'type': MessageType.RESPONSE_Transaction,
    'data': JSON.stringify([getLatestTx()])

})


var write = (ws, message) => ws.send(JSON.stringify(message));
var broadcast = (message) => sockets.forEach(socket => write(socket, message));

connectToPeers(initialPeers);
initHttpServer();
initP2PServer();
