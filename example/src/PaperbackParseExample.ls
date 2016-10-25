package
{
    import loom.Application;
    import loom2d.display.StageScaleMode;
    import loom2d.display.Image;
    import loom2d.textures.Texture;    
    import loom2d.events.Event;
    import loom2d.events.Touch;
    import loom2d.events.TouchEvent;
    import loom2d.events.TouchPhase;
    import system.ByteArray;

    import loom2d.text.TextField;    
    import loom2d.text.BitmapFont;
    
    import feathers.themes.MetalWorksMobileTheme;
    import feathers.controls.TextInput;
    import feathers.controls.Button;    
    import feathers.controls.Label;
    import feathers.events.FeathersEventType;

    import loom.social.Parse;

    public class PaperbackParseExample extends Application
    {
        var sessionToken:String;

        override public function run():void
        {
            Parse.baseServerURL = "http://localhost:1337/parse/";

            //Get REST credentials from loom.config file and pass to Parse
            var config = new JSON();
            config.loadString(Application.loomConfigJSON);
            Parse.REST_setCredentials(config.getString("parse_app_id"));

            //Set our onTimeout delegate. This will trigger after 10 seconds (by default) without a server response.
            Parse.REST_onTimeout = function()
            {
                trace("Timed out");
            };

            loginUser("Alice", "p", loggedIn);
        }

        private function loggedIn()
        {    
            Parse.REST_callCloudFunction(
                "createGame",
                JSON.fromDictionary({
                    "slotNum": 2,
                    "isRandom": false,
                    "fameCardNum": 10,
                    "aiNum": 0,
                    "turnMaxSec": 60
                }),
                function(result:ByteArray)
                {
                    trace("Created game: " + result.toString());
                },
                function(result:ByteArray)
                {
                    trace("Error: " + result.toString());
                }
            );
        }

        //Call the Parse tick function to increment timeout and the request queue timer.
        //If this is not called, requests will not send or time out.
        override public function onTick():void
        {            
            super.onTick();

            //tick Parse so that it can handle timeouts
            Parse.tick();
        }

        public function loginUser(username:String, password:String, done:Function)
        {
            Parse.REST_loginWithUsername(
                username,
                password,
                function(result:ByteArray) //request success delegate
                {
                    //Create a JSON object to parse the result the server returned
                    var responseJSON:JSON = JSON.parse(result.toString());

                    var username:String = responseJSON.getString("username");
                    trace("Logged in as " + username);
                    
                    Parse.REST_SessionToken = responseJSON.getString("sessionToken");

                    //If Parse Push Notes are supported on this device, we pass the username to the Installation so we can target our push notes.
                    if (Parse.isActive())
                    {
                        Parse.updateInstallationUserID(username);
                    }

                    done();
                },
                function(result:String) //request failure delegate
                {
                    trace("Login failed:");
                    trace(result);
                }
            );
        }
        
    }
}