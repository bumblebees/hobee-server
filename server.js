var MongoClient = require('mongodb').MongoClient, format = require('util').format;

var io = require('socket.io')(3001);
var mqtt = require('mqtt');
var broker = mqtt.connect('mqtt://localhost');
var util = require('util');
var fs = require('fs');

/////////////
// Options //
/////////////

// MQTT listening to these topics
var topics = [
	'geo/#'];


MongoClient.connect('mongodb://127.0.0.1/hobee', function(err, db){

	////////////
	// Socket //
	////////////

	// Here connection with android socket happens
	io.on('connection', function(socket) {

  		// Save user in the database
  		socket.on('register_user', function(data){
			db.collection('users').insert(JSON.parse(data));
			console.log(data);
  		});

		// Update user profile
		socket.on('update_user', function(data){
			parsedData = JSON.parse(data);
			console.log(parsedData);
			db.collection('users').update({'userID': parsedData.userID}, parsedData);
			
		});

  		////////////////////////////

		// When registering user save received image in local directory
  		socket.on('save_image', function(image){
  			var userId = image.userId;
  			var imageString = image.imageString;

  			console.log('image received');

  			fs.writeFile('storage/userImages/' + userId + '.png', imageString, 'base64', function(error){
  				if(error){
  					console.log(err);
  				}
  				else {
  					console.log('image saved');
  				}
  			});
  		});

  		////////////////////////////

		// Check if the user exists on the database and send respose to the app true/false
		socket.on('user_exists', function(data, fn){
			db.collection('users').find({'loginId': data}).count(function(err, count){
				if(count === 0){
					fn(false);
					console.log("user does not exist, register");
					console.log(data);
				}
				else{
					fn(true);
					console.log("user exists");
				}
			});
		});

		////////////////////////////

		// Return user by requested loginId
		socket.on('get_user', function(data, fn){
			console.log("<< get user >>");
			db.collection('users').findOne({'loginId':data},function(err, item){
				fn(item);
			});
		});

		// Return user by requested userID
		socket.on('get_userUUID', function(data, fn){
			console.log("<< get user UUID >>");
			db.collection('users').findOne({'userID':data},function(err, item){
				fn(item);
			});
		});

		////////////////////////////

		// Add or update user hobby
		socket.on('add_update_hobby', function(data){
			var hobby = JSON.parse(data.hobby);
			//remove the current hobby, if it exists
			db.collection('users').update({'userID':data.userID}, {$pull: {hobbies: {name:hobby.name}}});
			//add the new hobby
			db.collection('users').update({'userID':data.userID}, {$push: {hobbies:hobby}});
		});

		////////////////////////////

		//Get array of users (for ranks)
		socket.on('get_user_array', function(data, fn){
			var users = [];
			db.collection('users').find({userID: {$in: data.array}}).forEach((feed) => {users.push(feed);}, () => fn(users));
		});

		////////////////////////////

		// Return events where user has participated
		socket.on('get_event_history', function(data, fn){
			var now = new Date().getTime();
			var nowString = now.toString().slice(0, -3);
			console.log('Now ' + nowString);
			var events = [];
			db.collection('events').find({
				$and: [
					{'event_details.users_accepted': {$elemMatch: {userID: data}}},
					{'event_details.timestamp': {$lt: nowString}}
				]
			}).forEach((feed) => {events.push(feed);}, () => fn(events));
		});

		////////////////////////////

		// After user submits his ranking results, evaluate and save them
		socket.on('save_ranks', function(data){
			// Received data structure
			// {
			// 	hasRanked: true/false,
			// 	userID: "",
			// 	eventID: "",
			//	hostRep: "",
			// 	userReps: [[userID(String), reputation(int), noshow(boolean)]],
			// }

			// Remove the user from the events' list of users who haven't ranked yet	
			db.collection('events').update({eventID: data.eventID}, {$pull: {'event_details.users_unranked': data.userID}});
			
			db.collection('events').findOne({eventID: data.eventID}, function(err, event) {


					// If user has casted any rank
				if (data.hasRanked) {
					// If user ranked the host
					if (data.hostRep !== null) {
						db.collection('users').update({userID: event.event_details.host_id}, {$inc: {'rank.hostRep': data.hostRep}});
					};
					

					if (data.userReps.length > 0) {
						for (var i = 0; i < data.userReps.length; i++){
							if (data.userReps[i][2] === false){
								db.collection('users').update({userID: data.userReps[i][0]}, {$inc: {'rank.globalRep': data.userReps[i][1]}});
							}
							else {
								db.collection('users').update({userID: data.userReps[i][0]}, {$inc: {'rank.noShows': 1}});
								db.collection('events').update({eventID: data.eventID}, {$pull: {'event_details.users_unranked': data.userReps[i][0]}, 'event_details.users_accepted': data.userReps[i][0]})
							}
						};
					};
				}
			});


			
			

			
		});
	});



	//////////
	// MQTT //
	//////////

	// Here we connect to the broker and start listening to the topics
	broker.on('connect', function(){
		broker.subscribe(topics);
		topics.forEach(function(element){
			console.log('Subscribed: ' + element);
		});
	});

	// Here broker gets a message from sertain topic
	broker.on('message', function (topic, message){

		var eventTopic = "event/hobby/";
		//check if the topic contains the string "event/hobby/"
		if (topic.indexOf(eventTopic)!==-1 && message.toString()!==""){
			var newEvent = JSON.parse(message.toString());
			console.log("received an event");
			if(newEvent.hasOwnProperty("status")){
				//this is a cancelled event
				//get the current event from the collection 
				db.collection('events').findOne({'eventID': newEvent.eventID}, function(err, item){
					if(item!==null){
						//add the cancelled event to the cancelled events collection
						var cancelledEvent = {
							"event": item,
							"reason": newEvent.reason, 
							"timeCancelled": newEvent.timestamp
						};
						db.collection('cancelledEvents').insert(cancelledEvent);
						console.log("An event was cancelled");
						
						//get the host of the event and decrease his reputation
						db.collection('users').findOne({'userID':item.event_details.host_id}, function(err, host){

							//get the number of accepted users in the event
							var acceptedUsers = item.event_details.users_accepted.length - 1;
							//how much reputation is lost per user who was acccepted
							var decreasePerUser = 10;
							//calculate the new reputation
							var newRank = host.rank.hostRep - (decreasePerUser * acceptedUsers);
								
							db.collection('users').update({userID: event.event_details.host_id}, {'rank.hostRep': newRank});			
							
						});		
					}					
				});
				//remove the event from the collection of active events
				db.collection('events').remove({'eventID': newEvent.eventID}, function (err, res){
					console.log("event removed");
				});

			}
			else{ //this is a new or an updated event
				//update an event if something has changed, otherwise insert a new entry into the database
				db.collection('events').update({'eventID':newEvent.eventID}, newEvent, {upsert:true});
				console.log("event updated");
			}
		}
	});
});


////////////////////////
//// API for images ////
////////////////////////

// Create a REST API and retur user images when requesting http://<<server address>>:3003/api/containers/userImages/download/<<userId>>.png

var loopback = require('loopback');
var boot = require('loopback-boot');
var path = require('path');

var app = module.exports = loopback();

var ds = loopback.createDataSource({
    connector: require('loopback-component-storage'),
    provider: 'filesystem',
    root: path.join(__dirname, 'storage')
});

var container = ds.createModel('container');

app.start = function() {
  // start the web server
  return app.listen(function() {
    app.emit('started');
  });
};

boot(app, __dirname, function(err) {
  if (err) throw err;
  app.start();
});
