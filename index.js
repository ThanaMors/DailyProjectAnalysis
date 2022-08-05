const fetch = require("node-fetch");
const fs = require("fs");
const { RateLimit } = require("async-sema");
const collections = require("./collections.json");
const Web3 = require("web3");
const nftAbi = require("./abis/nftabi.json");
const orderFulfilledEvent = require("./abis/orderFulfilledEvent.json");
require("dotenv").config();

//WEB3 INSTANCE WITH WEBSOCKET PROVIDER (INFURA)
let web3 = new Web3(
  new Web3.providers.WebsocketProvider(process.env.INFURA_KEY, {
    clientConfig: {
      keepalive: true,
      keepaliveInterval: 60000,
      maxReceivedFrameSize: 10000000000,
      maxReceivedMessageSize: 10000000000,
    },
  })
);

const slugs = [];
const addresses = [];
const mapping = new Map();
collections.forEach((coll) => {
  slugs.push(coll.slug);
  addresses.push(coll.address);
  mapping.set(coll.slug, coll.address);
});

const getByValue = (map, searchValue) => {
  for (let [key, value] of map.entries()) {
    if (value === searchValue) return key;
    if (key === searchValue) return value;
  }
};

const fetchFromOSApi = async (slug) => {
  const options = {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-API-KEY": "a45e32796c5d467b8befbf050ca76c98",
    },
  };

  const url = `https://api.opensea.io/api/v1/collection/${slug}/stats`;

  let tempObj = {};

  await fetch(url, options)
    .then((response) => response.json())
    .then((response) => {
      let floor = response.stats["floor_price"];
      let address = getByValue(mapping, slug);
      let numSales = response.stats["one_day_sales"];
      let numVolume = response.stats["one_day_volume"].toFixed(2);
      let priceChange = response.stats["one_day_change"].toFixed(2);

      tempObj = {
        name: slug,
        address: address,
        OSfloor: floor,
        OSsales: numSales,
        OSvolume: numVolume,
        OSpriceChange: priceChange,
      };
    })
    .catch((err) => console.error(err));

  return tempObj;
};

const fetchFromLRApi = async (address) => {
  const url = `https://api.looksrare.org/api/v1/collections/stats?address=${address}`;

  let obj = {};
  await fetch(url)
    .then((response) => response.json())
    .then((response) => {
      let floor = web3.utils.fromWei(response.data.floorPrice, "ether");
      let numSales = response.data.count24h;
      let volume = web3.utils.fromWei(response.data.volume24h, "ether");
      let priceChange = response.data.floorChange24h.toFixed(2);

      obj = {
        address: address,
        LRfloor: floor,
        LRsales: numSales,
        LRvolume: volume,
        LRpriceChange: priceChange,
      };

      //console.log(obj);
    })
    .catch((err) => console.error(err));

  return obj;
};

let allData = [];

//addresses
const seaportAddress =
  "0x00000000006c3852cbEf3e08E8dF289169EdE581".toLowerCase();

const getOSSales = (saleLog, txHash, addy) => {
  let total = 0;
  let tokenId;
  if (saleLog.consideration[0].itemType === "2") {
    total = Number(web3.utils.fromWei(saleLog.offer[0].amount, "ether"));
    tokenId = saleLog.consideration[0].identifier.toString();
  } else {
    saleLog.consideration.forEach((con, index) => {
      let temp = Number(web3.utils.fromWei(con.amount, "ether"));
      total += temp;
      tokenId = saleLog.offer[0].identifier;
    });
  }

  let obj = {
    tokenID: tokenId,
    price: total.toFixed(2),
    txHash: txHash,
  };

  return obj;
};

const getSales = async (res, addy) => {
  const receipts = [];
  //get all receipts and put it into receipts array
  try {
    for (let event of res) {
      await web3.eth
        .getTransactionReceipt(event.transactionHash)
        .then(async (txReceipt) => {
          let firstLog = txReceipt.logs[0];
          let lastLog = txReceipt.logs[txReceipt.logs.length - 1];
          if (lastLog.address.toLowerCase() === seaportAddress) {
            firstLog = lastLog;
          }
          if (firstLog.address.toLowerCase() === seaportAddress) {
            let saleLog = web3.eth.abi.decodeLog(
              orderFulfilledEvent,
              firstLog.data,
              firstLog.topics.slice(1)
            );

            let sale = getOSSales(saleLog, txReceipt.transactionHash, addy);
            receipts.push(sale);
          }
        });
    }
    //sort sales
    receipts.sort(function (obj1, obj2) {
      return obj2.price - obj1.price;
    });

    //splice to get top 3
    receipts.splice(3, receipts.length - 1);
    return receipts;
  } catch (e) {
    console.log("ERROR -> ", e);
  }
};

const getTopThree = async (addy) => {
  let contract = new web3.eth.Contract(nftAbi, addy.toLowerCase());
  const currentblock = await web3.eth.getBlockNumber();
  const pastBlock = currentblock - 6500;

  //array
  const transferEvent = await contract.getPastEvents("Transfer", {
    fromBlock: pastBlock,
    toBlock: currentblock,
  });

  const sale = await getSales(transferEvent, addy);

  return sale;
};

const main = async () => {
  fs.writeFile("data.txt", "Collection Analysis\n", (err) => {
    if (err) throw err;
    console.log("File Created Successfully!");
  });

  const OSlimit = RateLimit(5, { uniformDistribution: true });

  for (let elem of addresses) {
    //elem = web3.utils.toChecksumAddress(elem).replace(/\s/g, "");
    //get slug based on address mapping
    const slug = getByValue(mapping, elem);
    //pull looksrare data
    const lrRes = await fetchFromLRApi(elem);
    //get top three sales
    const topThreeSale = await getTopThree(elem);
    const salesObj = { topThreeSales: JSON.stringify(topThreeSale) };
    //get OS data
    await OSlimit();
    const osRes = await fetchFromOSApi(slug);

    allData.push({ ...osRes, ...lrRes, ...salesObj });
  }
  //console.log(allData);
  for (let obj of allData) {
    let name = obj.name.toUpperCase();
    let osFloor = `${obj.OSfloor}E`;
    let osSales = `${obj.OSsales}`;
    let osVolume = `${obj.OSvolume}E`;
    let osChange = `${obj.OSpriceChange}%`;

    let lrFloor = `${obj.LRfloor}E`;
    let lrSales = `${obj.LRsales}`;
    let lrVolume = `${obj.LRvolume}E`;
    let lrChange = `${obj.LRpriceChange}%`;

    let OSlink = `https://opensea.io/assets/ethereum/${obj.address}/`;
    let topSales = JSON.parse(obj.topThreeSales);
    let salesLength = topSales.length;

    let sales;
    if (salesLength === 3) {
      let topSale = `#1: Price: ${topSales[0].price}, OpenSea: ${OSlink}${topSales[0].tokenID}`;
      let secondSale = `#2: Price: ${topSales[1].price}, OpenSea: ${OSlink}${topSales[1].tokenID}`;
      let thirdSale = `#3: Price: ${topSales[2].price}, OpenSea: ${OSlink}${topSales[2].tokenID}`;

      sales = `Top OS Sales: \n${topSale}\n${secondSale}\n${thirdSale}\n\n\n`;
    } else if (salesLength === 2) {
      let topSale = `#1: Price: ${topSales[0].price}, OpenSea: ${OSlink}${topSales[0].tokenID}`;
      let secondSale = `#2: Price: ${topSales[1].price}, OpenSea: ${OSlink}${topSales[1].tokenID}`;

      sales = `Top OS Sales: \n${topSale}\n${secondSale}\n\n\n`;
    } else if (salesLength === 1) {
      let topSale = `#1: Price: ${topSales[0].price}, OpenSea: ${OSlink}${topSales[0].tokenID}`;

      sales = `Top OS Sales: \n${topSale}\n\n\n`;
    } else {
      sales = `No sales found!\n\n\n`;
    }

    let OSoutput = `\t\t\t${name}\nOPENSEA:  Floor: ${osFloor}  Sales: ${osSales}  Volume: ${osVolume}  24HR Change: ${osChange}\n`;
    let LRoutput = `LOOKSRARE: Floor: ${lrFloor}  Sales: ${lrSales}  Volume: ${lrVolume}  24HR Change: ${lrChange}\n`;

    fs.appendFile("data.txt", OSoutput + LRoutput + sales, (err) => {
      if (err) console.log(err);
      console.log("Added to file!");
    });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
