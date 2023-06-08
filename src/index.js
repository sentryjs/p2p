const fs = require('fs');
const net = require('net');
const EventEmitter = require('events');
const splitStream = require('./split-stream');

const PEER_LIST_FILE = process.cwd() + '/Data/peerlist.json';
var peerList = [];

const random4digithex = () => Math.random().toString(16).split('.')[1].substr(0, 4);
const randomuuid = () => new Array(8).fill(0).map(() => random4digithex()).join('-');

function writePeerList(newPeerList) {
  peerList = newPeerList;
  fs.writeFileSync(PEER_LIST_FILE, JSON.stringify(peerList), 'utf8');
}

console.log(PEER_LIST_FILE);

module.exports = (options) => {
  //
  // Layer 1 - handle all the established connections, store
  // them in a map and emit corresponding events
  //
  const connections = new Map();
  const emitter = new EventEmitter();

  // Handle all TCP connections same way, no matter
  // if it's incoming or outgoing, we're P2P
  // const handleNewSocket = (socket) => {
  //   const connectionId = randomuuid();

  //   connections.set(connectionId, socket);
  //   emitter.emit('_connect', connectionId);

  //   socket.on('close', () => {
  //     connections.delete(connectionId);
  //     emitter.emit('_disconnect', connectionId);
  //   });

  //   socket.on('error', (error) => {
  //     emitter.emit('_connectionError', { connectionId, error });
  //   });

  //   socket.pipe(splitStream()).on('data', (message) => {
  //     emitter.emit('_message', { connectionId, message });
  //   });
  // };
  const handleNewSocket = (socket) => {
    const connectionId = randomuuid();
  
    connections.set(connectionId, socket);
    emitter.emit('_connect', connectionId);
  
    const newPeer = {
      id: randomuuid(),
      ip: socket.remoteAddress,
      port: socket.remotePort,
    };
  
    if (peerList.some(p => p.ip !== socket.remoteAddress)) {
      peerList.push(newPeer);
      writePeerList(peerList);
    }
  
    socket.on('close', () => {
      connections.delete(connectionId);
      emitter.emit('_disconnect', connectionId);
  
      peerList = peerList.filter((peer) => peer.id !== newPeer.id);
      writePeerList(peerList);
    });
  
    socket.on('error', (error) => {
      emitter.emit('_connectionError', { connectionId, error });
    });
  
    socket.pipe(splitStream()).on('data', (message) => {
      emitter.emit('_message', { connectionId, message });
    });
  };

  // Create a server itself and make it able to handle
  // all new connections and put them in the connections map
  const server = net.createServer((socket) => handleNewSocket(socket));

  // A method to "raw" send data by the connection ID
  // intended for internal use only
  const _send = (connectionId, message) => {
    const socket = connections.get(connectionId);

    if (!socket) {
      throw new Error(`Attempt to send data to a connection that does not exist: ${connectionId}`);
    }

    socket.write(JSON.stringify(message));
  };

  // A method for the library consumer to
  // establish a connection to other nodes
  const connect = (ip, port, cb) => {
    const socket = new net.Socket();

    socket.connect(port, ip, () => {
      handleNewSocket(socket);
      cb && cb();
    });

    socket.on('error', (error) => {
      emitter.emit('_connectionError', { peerIp: ip, connectionId: null, error });
    });

    // Return a disconnect function so you can
    // exclude the node from the list
    return (cb) => socket.destroy(cb);
  };

  // A method to actually start the server
  const listen = (port, cb) => {
    server.listen(port, '0.0.0.0', cb);

    return (cb) => server.close(cb);
  };

  // One method to close all open connections
  // and the server itself
  const close = (cb) => {
    for (let [connectionId, socket] of connections) {
      socket.destroy();
    }

    server.close(cb);
  };

  //
  // Layer 2 - create Nodes, assign IDs, handshake
  // and keep neighbors in a collection
  //
  const NODE_ID = randomuuid();
  const neighbors = new Map();

  // A helper to find the node ID by the connection ID
  const findNodeId = (connectionId) => {
    for (let [nodeId, $connectionId] of neighbors) {
      if (connectionId === $connectionId) {
        return nodeId;
      }
    }
  };

  // Once the connection is established, send the handshake message
  emitter.on('_connect', (connectionId) => {
    _send(connectionId, { type: 'handshake', data: { nodeId: NODE_ID } });
  });

  // On message, we check whether it's a handshake and add
  // the node to the neighbors list
  emitter.on('_message', ({ connectionId, message }) => {
    const { type, data } = message;

    if (type === 'handshake') {
      const { nodeId } = data;

      neighbors.set(nodeId, connectionId);
      emitter.emit('connect', { nodeId });
    }

    if (type === 'message') {
      const nodeId = findNodeId(connectionId);

      // TODO handle no nodeId error

      emitter.emit('message', { nodeId, data });
    }
  });

  emitter.on('_disconnect', (connectionId) => {
    const nodeId = findNodeId(connectionId);

    // TODO handle no nodeId

    neighbors.delete(nodeId);
    emitter.emit('disconnect', { nodeId });
  });

  emitter.on('_connectionError', ({ connectionId, error }) => {
    if (connectionId) {
      const nodeId = findNodeId(connectionId);

      // TODO handle no nodeId

      neighbors.delete(nodeId);
      emitter.emit('disconnect', { nodeId });
    } else {
      // console.error('Connection error:', error);
    }
  });

  // Finally, we send data to the node
  // by finding its connection and using _send
  const send = (nodeId, data) => {
    const connectionId = neighbors.get(nodeId);

    // TODO handle no connection ID error

    _send(connectionId, { type: 'message', data });
  };

  //
  // Layer 3 - here we can actually send data OVER
  // other nodes by doing recursive broadcast
  //
  const alreadySeenMessages = new Set();

  // A method to send a packet to other nodes (all neighbors)
  const sendPacket = (packet) => {
    for (const $nodeId of neighbors.keys()) {
      send($nodeId, packet);
    }
  };

  // 2 methods to send data either to all nodes in the network
  // or to a specific node (direct message)
  const broadcast = (message, id = randomuuid(), origin = NODE_ID, ttl = 255) => {
    sendPacket({ id, ttl, type: 'broadcast', message, origin });
  };

  const direct = (destination, message, id = randomuuid(), origin = NODE_ID, ttl = 255) => {
    sendPacket({ id, ttl, type: 'direct', message, destination, origin });
  };

  // Listen to all packets arriving from other nodes and
  // decide whether to send them next and emit a message
  emitter.on('message', ({ nodeId, data: packet }) => {
    // First of all, we decide whether this message at
    // any point has been sent by us. We do it in one
    // place to replace with a strategy later TODO
    if (alreadySeenMessages.has(packet.id) || packet.ttl < 1) {
      return;
    } else {
      alreadySeenMessages.add(packet.id);
    }

    // Let's pop up the broadcast message and send it
    // forward on the chain
    if (packet.type === 'broadcast') {
      emitter.emit('broadcast', { message: packet.message, origin: packet.origin });
      broadcast(packet.message, packet.id, packet.origin, packet.ttl - 1);
    }

    // If the peer message is received, figure out if it's
    // for us and send it forward if not
    if (packet.type === 'direct') {
      if (packet.destination === NODE_ID) {
        emitter.emit('direct', { origin: packet.origin, message: packet.message });
      } else {
        direct(packet.destination, packet.message, packet.id, packet.origin, packet.ttl - 1);
      }
    }
  });

  return {
    listen,
    connect,
    close,
    broadcast,
    direct,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    id: NODE_ID,
    neighbors: () => neighbors.keys(),
  };
};
